/**
 * Prepaid credit wallet storage (D1). Balances are integer micro-USD.
 *
 * Every balance change writes one `credit_ledger_entries` row in the same
 * D1 batch as the balance update, so the ledger always explains the
 * balance. Top-ups and auto-refills are idempotent on `stripe_reference`
 * (unique); admin grants record who granted, the amount, the recipient,
 * when, and an optional note. Debits live in `credit-debits.ts`.
 */
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	computeMonthlyOverage,
	computeOverageWarningResourceLabels,
} from '#universal/compute-overage.ts'
import { type AccountCreditsLedgerItem } from '#universal/loader-data.ts'
import {
	creditDebitMeters,
	defaultCreditAutoRefillSettings,
	defaultCreditNotifySettings,
	microUsdPerCent,
	type CreditAutoRefillSettings,
	type CreditDebitMeter,
	type CreditLedgerEntryKind,
	type CreditNotifySettings,
} from '#universal/credits.ts'
import { type UserEntitlement } from '#universal/plans.ts'
import { getUserEntitlement } from '#worker/entitlements/service.ts'
import { readMonthlyComputeUsage } from './compute-overage-usage.ts'

export type CreditWalletRow = {
	user_id: string
	balance_micro_usd: number
	auto_refill_enabled: number
	auto_refill_threshold_cents: number | null
	auto_refill_amount_cents: number | null
	auto_refill_monthly_cap_cents: number | null
	auto_refill_payment_method_id: string | null
	auto_refill_failed_at: string | null
	notify_auto_refilled: number
	notify_monthly_cap: number
	notify_low_balance: number
	created_at: string
	updated_at: string
}

export type CreditWallet = {
	userId: string
	balanceMicroUsd: number
	autoRefill: CreditAutoRefillSettings
	autoRefillPaymentMethodId: string | null
	autoRefillFailedAt: string | null
	notify: CreditNotifySettings
}

export type CreditLedgerEntry = {
	id: string
	kind: CreditLedgerEntryKind
	amountMicroUsd: number
	meter: string | null
	month: string | null
	units: number | null
	grantedByUserId: string | null
	note: string | null
	createdAt: string
}

const walletColumns = `user_id, balance_micro_usd, auto_refill_enabled,
	auto_refill_threshold_cents, auto_refill_amount_cents,
	auto_refill_monthly_cap_cents, auto_refill_payment_method_id,
	auto_refill_failed_at, notify_auto_refilled, notify_monthly_cap,
	notify_low_balance, created_at, updated_at`

export function toCreditWallet(row: CreditWalletRow): CreditWallet {
	return {
		userId: row.user_id,
		balanceMicroUsd: Number(row.balance_micro_usd),
		autoRefill: {
			enabled: Number(row.auto_refill_enabled) === 1,
			thresholdCents: row.auto_refill_threshold_cents,
			amountCents: row.auto_refill_amount_cents,
			monthlyCapCents: row.auto_refill_monthly_cap_cents,
		},
		autoRefillPaymentMethodId: row.auto_refill_payment_method_id,
		autoRefillFailedAt: row.auto_refill_failed_at,
		notify: {
			autoRefilled: Number(row.notify_auto_refilled) === 1,
			monthlyCap: Number(row.notify_monthly_cap) === 1,
			lowBalance: Number(row.notify_low_balance) === 1,
		},
	}
}

/** Wallet for a user, or the defaults (zero balance, auto-refill off). */
export async function readCreditWallet(
	db: D1Database,
	userId: string,
): Promise<CreditWallet> {
	const row = await db
		.prepare(`SELECT ${walletColumns} FROM credit_wallets WHERE user_id = ?`)
		.bind(userId)
		.first<CreditWalletRow>()
	if (row) return toCreditWallet(row)
	return {
		userId,
		balanceMicroUsd: 0,
		autoRefill: defaultCreditAutoRefillSettings,
		autoRefillPaymentMethodId: null,
		autoRefillFailedAt: null,
		notify: defaultCreditNotifySettings,
	}
}

/**
 * Create the wallet row on first use, with debit progress at the usage
 * already above the include (see {@link forgiveUnchargedCreditUsage}).
 */
export async function ensureCreditWallet(input: {
	db: D1Database
	userId: string
	entitlement: UserEntitlement
	now: Date
}): Promise<void> {
	const nowIso = input.now.toISOString()
	const created = await input.db
		.prepare(
			`INSERT OR IGNORE INTO credit_wallets (user_id, created_at, updated_at)
			 VALUES (?, ?, ?)`,
		)
		.bind(input.userId, nowIso, nowIso)
		.run()
	if (!Number(created.meta.changes ?? 0)) return
	await forgiveUnchargedCreditUsage(input)
}

/**
 * Advance debit progress for every month the debit lane settles (prior and
 * current UTC month) to the usage already above the include. Runs when a
 * wallet is created and when an empty wallet is funded, so credits never
 * pay for usage incurred while the wallet was empty. Usage that has not
 * reached `usage_rollups` yet (under an hour) is still debited later.
 */
export async function forgiveUnchargedCreditUsage(input: {
	db: D1Database
	userId: string
	entitlement: UserEntitlement
	now: Date
}): Promise<void> {
	const nowIso = input.now.toISOString()
	const statements: Array<D1PreparedStatement> = []
	for (const month of creditDebitMonths(input.now)) {
		const usage = await readMonthlyComputeUsage({
			db: input.db,
			stableUserId: input.userId,
			month,
		})
		const overage = computeMonthlyOverage({
			plan: input.entitlement.plan,
			ladder: input.entitlement.ladder,
			creditWallet: input.entitlement.creditWallet,
			uniqueWorkerDays: usage.uniqueWorkerDays,
			durableObjectRowsRead: usage.durableObjectRowsRead,
		})
		const billableByMeter = {
			unique_worker_days: overage.billableUniqueWorkerDays,
			durable_object_rows_read: overage.billableDurableObjectRowsRead,
		} as const satisfies Record<CreditDebitMeter, number>
		for (const meter of creditDebitMeters) {
			statements.push(
				input.db
					.prepare(
						`INSERT INTO credit_debit_progress
							(user_id, month, meter, accounted_units, updated_at)
						 VALUES (?, ?, ?, ?, ?)
						 ON CONFLICT (user_id, month, meter) DO UPDATE SET
							accounted_units = MAX(accounted_units, excluded.accounted_units),
							updated_at = excluded.updated_at`,
					)
					.bind(input.userId, month, meter, billableByMeter[meter], nowIso),
			)
		}
	}
	await input.db.batch(statements)
}

/** Forgive uncharged usage when a credit is about to fund an empty wallet. */
async function forgiveBeforeFunding(input: {
	db: D1Database
	userId: string
	now: Date
}) {
	const wallet = await readCreditWallet(input.db, input.userId)
	if (wallet.balanceMicroUsd > 0) return
	await forgiveUnchargedCreditUsage({
		...input,
		entitlement: await getUserEntitlement(input.db, {
			userId: input.userId,
			email: null,
		}),
	})
}

/** UTC months the debit lane settles: the prior month, then the current. */
export function creditDebitMonths(now: Date): [string, string] {
	return [
		utcMonthKey(
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
		),
		utcMonthKey(now),
	]
}

function isUniqueConstraintError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return /UNIQUE constraint failed/i.test(message)
}

export type CreditTopUpResult = {
	applied: boolean
	balanceMicroUsd: number
}

/**
 * Credit a paid top-up or auto-refill. Replays of the same Stripe object
 * (webhook plus success redirect, retried refills) are no-ops.
 */
export async function applyCreditPayment(input: {
	db: D1Database
	userId: string
	kind: Extract<CreditLedgerEntryKind, 'top_up' | 'auto_refill'>
	amountCents: number
	stripeReference: string
	paymentMethodId?: string | null
	now: Date
}): Promise<CreditTopUpResult> {
	const nowIso = input.now.toISOString()
	const amountMicroUsd = input.amountCents * microUsdPerCent
	const paymentMethodId = input.paymentMethodId?.trim() || null
	await forgiveBeforeFunding(input)
	try {
		await input.db.batch([
			input.db
				.prepare(
					`INSERT OR IGNORE INTO credit_wallets (user_id, created_at, updated_at)
					 VALUES (?, ?, ?)`,
				)
				.bind(input.userId, nowIso, nowIso),
			input.db
				.prepare(
					`INSERT INTO credit_ledger_entries
						(id, user_id, kind, amount_micro_usd, month, stripe_reference, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					input.userId,
					input.kind,
					amountMicroUsd,
					utcMonthKey(input.now),
					input.stripeReference,
					nowIso,
				),
			input.db
				.prepare(
					`UPDATE credit_wallets
					 SET balance_micro_usd = balance_micro_usd + ?,
					     auto_refill_payment_method_id = COALESCE(?, auto_refill_payment_method_id),
					     auto_refill_failed_at = CASE WHEN ? = 'auto_refill' THEN NULL ELSE auto_refill_failed_at END,
					     updated_at = ?
					 WHERE user_id = ?`,
				)
				.bind(
					amountMicroUsd,
					paymentMethodId,
					input.kind,
					nowIso,
					input.userId,
				),
		])
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error
		const wallet = await readCreditWallet(input.db, input.userId)
		return { applied: false, balanceMicroUsd: wallet.balanceMicroUsd }
	}
	const wallet = await readCreditWallet(input.db, input.userId)
	return { applied: true, balanceMicroUsd: wallet.balanceMicroUsd }
}

export type CreditAdminGrantResult = {
	entryId: string
	balanceMicroUsd: number
	createdAt: string
}

/**
 * House-funded credit grant by an admin (including to themselves). No
 * Stripe charge. The ledger row is the audit record: granted_by, amount,
 * recipient, time, and note.
 */
export async function grantAdminCredits(input: {
	db: D1Database
	recipientUserId: string
	grantedByUserId: string
	amountCents: number
	note: string | null
	now: Date
}): Promise<CreditAdminGrantResult> {
	const nowIso = input.now.toISOString()
	const amountMicroUsd = input.amountCents * microUsdPerCent
	const entryId = crypto.randomUUID()
	await forgiveBeforeFunding({
		db: input.db,
		userId: input.recipientUserId,
		now: input.now,
	})
	await input.db.batch([
		input.db
			.prepare(
				`INSERT OR IGNORE INTO credit_wallets (user_id, created_at, updated_at)
				 VALUES (?, ?, ?)`,
			)
			.bind(input.recipientUserId, nowIso, nowIso),
		input.db
			.prepare(
				`INSERT INTO credit_ledger_entries
					(id, user_id, kind, amount_micro_usd, month, granted_by_user_id, note, created_at)
				 VALUES (?, ?, 'admin_grant', ?, ?, ?, ?, ?)`,
			)
			.bind(
				entryId,
				input.recipientUserId,
				amountMicroUsd,
				utcMonthKey(input.now),
				input.grantedByUserId,
				input.note?.trim() || null,
				nowIso,
			),
		input.db
			.prepare(
				`UPDATE credit_wallets
				 SET balance_micro_usd = balance_micro_usd + ?, updated_at = ?
				 WHERE user_id = ?`,
			)
			.bind(amountMicroUsd, nowIso, input.recipientUserId),
	])
	const wallet = await readCreditWallet(input.db, input.recipientUserId)
	return {
		entryId,
		balanceMicroUsd: wallet.balanceMicroUsd,
		createdAt: nowIso,
	}
}

/**
 * Save auto-refill and notice settings, creating the wallet row when a
 * settings save comes before any top-up. A wallet created here keeps a $0
 * balance; its first funding forgives earlier usage above the include.
 */
export async function updateCreditWalletSettings(input: {
	db: D1Database
	userId: string
	autoRefill: CreditAutoRefillSettings
	notify: CreditNotifySettings
	now: Date
}): Promise<CreditWallet> {
	const nowIso = input.now.toISOString()
	await input.db
		.prepare(
			`INSERT INTO credit_wallets (
				user_id, auto_refill_enabled, auto_refill_threshold_cents,
				auto_refill_amount_cents, auto_refill_monthly_cap_cents,
				notify_auto_refilled, notify_monthly_cap, notify_low_balance,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id) DO UPDATE SET
				auto_refill_enabled = excluded.auto_refill_enabled,
				auto_refill_threshold_cents = excluded.auto_refill_threshold_cents,
				auto_refill_amount_cents = excluded.auto_refill_amount_cents,
				auto_refill_monthly_cap_cents = excluded.auto_refill_monthly_cap_cents,
				notify_auto_refilled = excluded.notify_auto_refilled,
				notify_monthly_cap = excluded.notify_monthly_cap,
				notify_low_balance = excluded.notify_low_balance,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.autoRefill.enabled ? 1 : 0,
			input.autoRefill.thresholdCents,
			input.autoRefill.amountCents,
			input.autoRefill.monthlyCapCents,
			input.notify.autoRefilled ? 1 : 0,
			input.notify.monthlyCap ? 1 : 0,
			input.notify.lowBalance ? 1 : 0,
			nowIso,
			nowIso,
		)
		.run()
	return await readCreditWallet(input.db, input.userId)
}

export async function markCreditAutoRefillFailed(input: {
	db: D1Database
	userId: string
	now: Date
}) {
	await input.db
		.prepare(
			`UPDATE credit_wallets SET auto_refill_failed_at = ?, updated_at = ?
			 WHERE user_id = ?`,
		)
		.bind(input.now.toISOString(), input.now.toISOString(), input.userId)
		.run()
}

/** Whole cents auto-refilled in one UTC month (for the monthly cap). */
export async function sumCreditAutoRefillCents(input: {
	db: D1Database
	userId: string
	month: string
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT COALESCE(SUM(amount_micro_usd), 0) AS total
			 FROM credit_ledger_entries
			 WHERE user_id = ? AND kind = 'auto_refill' AND month = ?`,
		)
		.bind(input.userId, input.month)
		.first<{ total: number }>()
	return Math.round(Number(row?.total ?? 0) / microUsdPerCent)
}

export async function countCreditAutoRefills(input: {
	db: D1Database
	userId: string
	month: string
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count FROM credit_ledger_entries
			 WHERE user_id = ? AND kind = 'auto_refill' AND month = ?`,
		)
		.bind(input.userId, input.month)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

type CreditLedgerRow = {
	id: string
	kind: CreditLedgerEntryKind
	amount_micro_usd: number
	meter: string | null
	month: string | null
	units: number | null
	granted_by_user_id: string | null
	note: string | null
	created_at: string
}

export async function listCreditLedgerEntries(input: {
	db: D1Database
	userId: string
	limit: number
}): Promise<Array<CreditLedgerEntry>> {
	const rows = await input.db
		.prepare(
			`SELECT id, kind, amount_micro_usd, meter, month, units,
				granted_by_user_id, note, created_at
			 FROM credit_ledger_entries
			 WHERE user_id = ?
			 ORDER BY created_at DESC, id DESC
			 LIMIT ?`,
		)
		.bind(input.userId, input.limit)
		.all<CreditLedgerRow>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		kind: row.kind,
		amountMicroUsd: Number(row.amount_micro_usd),
		meter: row.meter,
		month: row.month,
		units: row.units == null ? null : Number(row.units),
		grantedByUserId: row.granted_by_user_id,
		note: row.note,
		createdAt: row.created_at,
	}))
}

function describeLedgerEntry(entry: CreditLedgerEntry): string {
	switch (entry.kind) {
		case 'top_up':
			return 'Added credits'
		case 'auto_refill':
			return 'Auto-refill'
		case 'admin_grant':
			return 'Credits granted'
		case 'debit': {
			const label =
				entry.meter && entry.meter in computeOverageWarningResourceLabels
					? computeOverageWarningResourceLabels[
							entry.meter as keyof typeof computeOverageWarningResourceLabels
						]
					: (entry.meter ?? 'Usage')
			const units =
				entry.units == null ? '' : ` (${entry.units.toLocaleString('en-US')})`
			return `${label}${units}`
		}
		default: {
			const exhaustive: never = entry.kind
			throw new Error(`Unknown ledger entry kind: ${String(exhaustive)}`)
		}
	}
}

export function toAccountCreditsLedgerItem(
	entry: CreditLedgerEntry,
): AccountCreditsLedgerItem {
	return {
		id: entry.id,
		kind: entry.kind,
		amountMicroUsd: entry.amountMicroUsd,
		description: describeLedgerEntry(entry),
		createdAt: entry.createdAt,
	}
}
