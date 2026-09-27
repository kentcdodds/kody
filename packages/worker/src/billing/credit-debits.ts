/**
 * Hourly credit debit lane. Runs right after `usage_aggregation` recomputes
 * `usage_rollups`, so debits only ever read a freshly recomputed month.
 *
 * For every wallet, per UTC month (the prior month while its rollup still
 * settles, and the current month) and per debit meter:
 *
 * - billable units = usage above the include for the account's current
 *   plan (purchasable Pro includes when wallet-eligible).
 * - `credit_debit_progress.accounted_units` is how many of those units were
 *   already handled. The delta is priced at the cumulative debit rate
 *   (`creditDebitCostMicroUsd(next) - creditDebitCostMicroUsd(accounted)`).
 * - A funded purchasable-Pro wallet is debited for the delta. The balance
 *   can dip below $0 by up to one hour of unlocked usage; it stays locked
 *   until a top-up covers it.
 * - Every other wallet (empty, or not eligible) advances progress without
 *   a debit: usage above the include without credits is not charged and is
 *   never back-charged by a later top-up.
 *
 * Debit ledger ids are deterministic per (user, month, meter, starting
 * units), so an overlapping run collides on the primary key and the whole
 * batch rolls back instead of charging twice.
 *
 * After debits, the lane runs auto-refill and the low-balance notice. Each
 * run is bounded; `credit_debit_cursor` keeps the keyset position so the
 * next run continues past the last wallet this one reached.
 */
import { computeMonthlyOverage } from '#universal/compute-overage.ts'
import {
	creditDebitCostMicroUsd,
	creditDebitMeters,
	crossedCreditLowBalance,
	type CreditDebitMeter,
} from '#universal/credits.ts'
import { type UserEntitlement } from '#universal/plans.ts'
import {
	isPayingForCreditsPro,
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { runCreditAutoRefill } from './credit-auto-refill.ts'
import { sendCreditLowBalanceEmail } from '#app/user-account-emails.ts'
import { creditDebitMonths } from './credit-wallet.ts'
import { readMonthlyComputeUsage } from './compute-overage-usage.ts'

export const creditDebitBatchSize = 50
export const creditDebitMaxBatchesPerRun = 20

type CreditDebitCandidateRow = UserEntitlementRow & {
	user_id: string
	email: string
	stripe_customer_id: string | null
	balance_micro_usd: number
	auto_refill_enabled: number
	notify_low_balance: number
}

export type CreditDebitMonthOutcome = {
	month: string
	debitedMicroUsd: number
	forgivenUnits: Record<CreditDebitMeter, number>
}

export type CreditDebitRunResult = {
	scanned: number
	debitedUsers: number
	debitedMicroUsd: number
	autoRefilled: number
	failed: number
	done: boolean
}

export async function runCreditDebits(input: {
	env: Env
	now: Date
}): Promise<CreditDebitRunResult> {
	const db = input.env.APP_DB
	const months = creditDebitMonths(input.now)
	let startAfter = await readCreditDebitCursor(db)
	let scanned = 0
	let debitedUsers = 0
	let debitedMicroUsd = 0
	let autoRefilled = 0
	let failed = 0
	let done = false
	for (let batch = 0; batch < creditDebitMaxBatchesPerRun; batch += 1) {
		const rows = await listCreditDebitCandidates({ db, startAfter })
		for (const row of rows) {
			try {
				const outcome = await debitOneWallet({
					env: input.env,
					row,
					months,
					now: input.now,
				})
				if (outcome.debitedMicroUsd > 0) {
					debitedUsers += 1
					debitedMicroUsd += outcome.debitedMicroUsd
				}
				if (outcome.autoRefilled) autoRefilled += 1
			} catch (error) {
				failed += 1
				console.error('credit_debit_failed', {
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		scanned += rows.length
		const last = rows.at(-1)
		if (!last || rows.length < creditDebitBatchSize) {
			done = true
			break
		}
		startAfter = last.user_id
	}
	// Resume where this bounded run stopped; wrap once the tail is reached.
	await writeCreditDebitCursor({
		db,
		position: done ? '' : startAfter,
		now: input.now,
	})
	return { scanned, debitedUsers, debitedMicroUsd, autoRefilled, failed, done }
}

async function readCreditDebitCursor(db: D1Database): Promise<string> {
	const row = await db
		.prepare(`SELECT position FROM credit_debit_cursor WHERE singleton = 1`)
		.first<{ position: string }>()
	return row?.position ?? ''
}

async function writeCreditDebitCursor(input: {
	db: D1Database
	position: string
	now: Date
}) {
	await input.db
		.prepare(
			`INSERT INTO credit_debit_cursor (singleton, position, updated_at)
			 VALUES (1, ?, ?)
			 ON CONFLICT (singleton) DO UPDATE SET
				position = excluded.position,
				updated_at = excluded.updated_at`,
		)
		.bind(input.position, input.now.toISOString())
		.run()
}

async function listCreditDebitCandidates(input: {
	db: D1Database
	startAfter: string
}): Promise<Array<CreditDebitCandidateRow>> {
	const rows = await input.db
		.prepare(
			`SELECT w.user_id, w.balance_micro_usd, w.auto_refill_enabled,
				w.notify_low_balance, u.email, u.stripe_customer_id,
				${userEntitlementColumnsSql('u')}
			 FROM credit_wallets w
			 INNER JOIN users u ON u.stable_user_id = w.user_id
			 WHERE u.deleting_at IS NULL AND w.user_id > ?
			 ORDER BY w.user_id
			 LIMIT ?`,
		)
		.bind(input.startAfter, creditDebitBatchSize)
		.all<CreditDebitCandidateRow>()
	return rows.results ?? []
}

async function debitOneWallet(input: {
	env: Env
	row: CreditDebitCandidateRow
	months: ReadonlyArray<string>
	now: Date
}): Promise<{ debitedMicroUsd: number; autoRefilled: boolean }> {
	const db = input.env.APP_DB
	const userId = input.row.user_id
	const entitlement = await resolveUserEntitlementFromRow({
		db,
		stableUserId: userId,
		row: input.row,
		now: input.now,
	})
	const previousBalance = Number(input.row.balance_micro_usd)
	let debitedMicroUsd = 0
	for (const month of input.months) {
		const outcome = await settleCreditDebitMonth({
			db,
			userId,
			entitlement,
			month,
			now: input.now,
		})
		debitedMicroUsd += outcome.debitedMicroUsd
	}
	if (entitlement.creditWallet === 'none') {
		return { debitedMicroUsd, autoRefilled: false }
	}
	const nextBalance = previousBalance - debitedMicroUsd
	// Gift and referral Pro overlays hold a wallet but never auto-charge.
	const autoRefill = isPayingForCreditsPro(input.row)
		? await runCreditAutoRefill({
				env: input.env,
				userId,
				email: input.row.email,
				stripeCustomerId: input.row.stripe_customer_id,
				now: input.now,
			})
		: 'skipped'
	if (
		Number(input.row.notify_low_balance) === 1 &&
		crossedCreditLowBalance({
			previousBalanceMicroUsd: previousBalance,
			nextBalanceMicroUsd: nextBalance,
			autoRefillEnabled: Number(input.row.auto_refill_enabled) === 1,
		})
	) {
		await sendCreditLowBalanceEmail({
			env: input.env,
			email: input.row.email,
			userId,
			balanceMicroUsd: nextBalance,
			now: input.now,
		}).catch((error: unknown) => {
			console.warn('credit-low-balance-email-failed', error)
		})
	}
	return { debitedMicroUsd, autoRefilled: autoRefill === 'charged' }
}

type ProgressRow = { meter: string; accounted_units: number }

/**
 * Settle one (user, month): debit the funded wallet for newly billable
 * units, or advance progress without a charge. Exported for tests.
 */
export async function settleCreditDebitMonth(input: {
	db: D1Database
	userId: string
	entitlement: UserEntitlement
	month: string
	now: Date
}): Promise<CreditDebitMonthOutcome> {
	const usage = await readMonthlyComputeUsage({
		db: input.db,
		stableUserId: input.userId,
		month: input.month,
	})
	const overage = computeMonthlyOverage({
		plan: input.entitlement.plan,
		ladder: input.entitlement.ladder,
		creditWallet: input.entitlement.creditWallet,
		uniqueWorkerDays: usage.uniqueWorkerDays,
		durableObjectRowsRead: usage.durableObjectRowsRead,
	})
	const billable: Record<CreditDebitMeter, number> = {
		unique_worker_days: overage.billableUniqueWorkerDays,
		durable_object_rows_read: overage.billableDurableObjectRowsRead,
	}
	const progressRows = await input.db
		.prepare(
			`SELECT meter, accounted_units FROM credit_debit_progress
			 WHERE user_id = ? AND month = ?`,
		)
		.bind(input.userId, input.month)
		.all<ProgressRow>()
	const accounted = new Map(
		(progressRows.results ?? []).map((row) => [
			row.meter,
			Number(row.accounted_units),
		]),
	)
	const charge = input.entitlement.creditWallet === 'funded'
	const nowIso = input.now.toISOString()
	const statements: Array<D1PreparedStatement> = []
	const forgivenUnits: Record<CreditDebitMeter, number> = {
		unique_worker_days: 0,
		durable_object_rows_read: 0,
	}
	let debitedMicroUsd = 0
	for (const meter of creditDebitMeters) {
		const from = accounted.get(meter) ?? 0
		const next = billable[meter]
		if (next <= from) continue
		if (charge) {
			const cost =
				creditDebitCostMicroUsd(meter, next) -
				creditDebitCostMicroUsd(meter, from)
			if (cost > 0) {
				debitedMicroUsd += cost
				statements.push(
					input.db
						.prepare(
							`INSERT INTO credit_ledger_entries
								(id, user_id, kind, amount_micro_usd, meter, month, units, created_at)
							 VALUES (?, ?, 'debit', ?, ?, ?, ?, ?)`,
						)
						.bind(
							`debit:${input.userId}:${input.month}:${meter}:${from}`,
							input.userId,
							-cost,
							meter,
							input.month,
							next - from,
							nowIso,
						),
				)
			}
		} else {
			forgivenUnits[meter] = next - from
		}
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
				.bind(input.userId, input.month, meter, next, nowIso),
		)
	}
	if (debitedMicroUsd > 0) {
		statements.push(
			input.db
				.prepare(
					`UPDATE credit_wallets
					 SET balance_micro_usd = balance_micro_usd - ?, updated_at = ?
					 WHERE user_id = ?`,
				)
				.bind(debitedMicroUsd, nowIso, input.userId),
		)
	}
	if (statements.length > 0) {
		try {
			await input.db.batch(statements)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (!/UNIQUE constraint failed/i.test(message)) throw error
			// An overlapping run already settled from this starting point.
			return {
				month: input.month,
				debitedMicroUsd: 0,
				forgivenUnits: {
					unique_worker_days: 0,
					durable_object_rows_read: 0,
				},
			}
		}
	}
	return { month: input.month, debitedMicroUsd, forgivenUnits }
}
