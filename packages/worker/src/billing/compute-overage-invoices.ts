/**
 * Monthly compute-overage invoicing. Reads `usage_rollups` for unique
 * worker days and Durable Object rows-read, prices the include-then-overage
 * delta, and either writes a dry-run/soft-block/legacy ledger row or
 * creates a standalone Stripe invoice with invoice items.
 *
 * Invoice items (not Stripe Billing Meters) so yearly subscribers still
 * get a UTC-month invoice and so this PR does not require new Stripe
 * price ids.
 */
import {
	computeMonthlyOverage,
	computeOverageBillingPolicy,
	previousUtcMonthKey,
	resolveComputeOverageDisposition,
	type ComputeOverageDisposition,
	type MonthlyComputeOverage,
} from '#universal/compute-overage.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	resolveEffectivePlan,
	type EntitlementLadder,
	type PlanName,
} from '#universal/plans.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { isBillingConfigured } from './billing-config.ts'
import { readMonthlyComputeUsage } from './compute-overage-usage.ts'
import {
	computeOverageInvoiceMetadataKey,
	computeOverageInvoiceMonthMetadataKey,
	createDraftInvoice,
	createInvoiceItem,
	finalizeInvoice,
	payInvoice,
} from './stripe-client.ts'

export const computeOverageInvoiceStatuses = [
	'pending',
	'invoiced',
	'dry_run',
	'soft_block',
	'skip_legacy',
	'skip_zero',
	'skip_audience',
	'failed',
] as const

export type ComputeOverageInvoiceStatus =
	(typeof computeOverageInvoiceStatuses)[number]

export const computeOverageBillingBatchSize = 25
export const computeOverageBillingCatchUpLastDay = 3

type OverageUserRow = {
	id: number
	stable_user_id: string
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stripe_customer_id: string | null
}

export type ComputeOverageBillingResult =
	| { status: 'skipped'; reason: 'outside_window' | 'billing_unconfigured' }
	| {
			status: 'completed'
			month: string
			scanned: number
			invoiced: number
			dryRun: number
			softBlocked: number
			skippedLegacy: number
			failed: number
			done: boolean
	  }

export function shouldInvoiceComputeOverageMonth(now: Date): boolean {
	const day = now.getUTCDate()
	if (day < 1 || day > computeOverageBillingCatchUpLastDay) return false
	return day > 1 || now.getUTCHours() >= 1
}

export async function runComputeOverageBilling(input: {
	env: Env
	now?: Date
	startAfter?: string
}): Promise<ComputeOverageBillingResult> {
	const now = input.now ?? new Date()
	if (!shouldInvoiceComputeOverageMonth(now)) {
		return { status: 'skipped', reason: 'outside_window' }
	}
	if (!isBillingConfigured(input.env)) {
		return { status: 'skipped', reason: 'billing_unconfigured' }
	}
	const month = previousUtcMonthKey(now)
	const users = await listOverageCandidates({
		db: input.env.APP_DB,
		month,
		startAfter: input.startAfter ?? '',
	})
	let invoiced = 0
	let dryRun = 0
	let softBlocked = 0
	let skippedLegacy = 0
	let failed = 0
	for (const user of users) {
		const outcome = await invoiceOneUserIfNeeded({
			env: input.env,
			user,
			month,
			now,
		})
		switch (outcome) {
			case 'invoiced':
				invoiced += 1
				break
			case 'dry_run':
				dryRun += 1
				break
			case 'soft_block':
				softBlocked += 1
				break
			case 'skip_legacy':
				skippedLegacy += 1
				break
			case 'failed':
				failed += 1
				break
			case 'skip_zero':
			case 'skip_audience':
			case 'pending':
				break
			default: {
				const exhaustive: never = outcome
				throw new Error(
					`Unknown compute overage invoice status: ${String(exhaustive)}`,
				)
			}
		}
	}
	return {
		status: 'completed',
		month,
		scanned: users.length,
		invoiced,
		dryRun,
		softBlocked,
		skippedLegacy,
		failed,
		done: users.length < computeOverageBillingBatchSize,
	}
}

async function listOverageCandidates(input: {
	db: D1Database
	month: string
	startAfter: string
}): Promise<Array<OverageUserRow>> {
	const rows = await input.db
		.prepare(
			`SELECT DISTINCT u.id, u.stable_user_id, u.plan, u.stripe_plan,
				u.entitlement_ladder, u.stripe_customer_id
			 FROM users u
			 LEFT JOIN usage_rollups r
				ON r.user_id = u.stable_user_id
				AND r.month = ?
				AND r.metric IN ('dynamic_worker_day', 'durable_object_rows_read')
			 WHERE u.deleting_at IS NULL
				AND u.stable_user_id > ?
				AND (u.stripe_customer_id IS NOT NULL OR r.user_id IS NOT NULL)
			 ORDER BY u.stable_user_id
			 LIMIT ?`,
		)
		.bind(input.month, input.startAfter, computeOverageBillingBatchSize)
		.all<OverageUserRow>()
	return rows.results ?? []
}

async function invoiceOneUserIfNeeded(input: {
	env: Env
	user: OverageUserRow
	month: string
	now: Date
}): Promise<ComputeOverageInvoiceStatus> {
	const existing = await input.env.APP_DB.prepare(
		`SELECT status, stripe_invoice_id FROM compute_overage_invoices
		 WHERE user_id = ? AND month = ?`,
	)
		.bind(input.user.stable_user_id, input.month)
		.first<{ status: string; stripe_invoice_id: string | null }>()
	if (
		existing &&
		existing.status !== 'pending' &&
		existing.status !== 'failed'
	) {
		return existing.status as ComputeOverageInvoiceStatus
	}

	const plan = resolveEffectivePlan(
		parseStoredPlanName(input.user.plan),
		input.user.stripe_plan,
	)
	const ladder = parseEntitlementLadder(input.user.entitlement_ladder)
	const usage = await readMonthlyComputeUsage({
		db: input.env.APP_DB,
		stableUserId: input.user.stable_user_id,
		month: input.month,
	})
	const overage = computeMonthlyOverage({
		plan,
		ladder,
		uniqueWorkerDays: usage.uniqueWorkerDays,
		durableObjectRowsRead: usage.durableObjectRowsRead,
	})
	const chargingEnabled = await isFeatureEnabled(
		input.env.APP_DB,
		'compute-overage-charging',
		input.user.id,
	)
	const disposition = resolveComputeOverageDisposition({
		plan,
		ladder,
		overage,
		hasStripeCustomer: Boolean(input.user.stripe_customer_id?.trim()),
		chargingEnabled,
		policy: computeOverageBillingPolicy,
	})
	const nowIso = input.now.toISOString()
	if (disposition !== 'invoice') {
		await upsertLedgerRow({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			month: input.month,
			overage,
			disposition,
			status: disposition,
			stripeCustomerId: input.user.stripe_customer_id,
			stripeInvoiceId: null,
			nowIso,
		})
		return disposition
	}

	const customerId = input.user.stripe_customer_id?.trim()
	if (!customerId) {
		await upsertLedgerRow({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			month: input.month,
			overage,
			disposition,
			status: 'dry_run',
			stripeCustomerId: null,
			stripeInvoiceId: null,
			nowIso,
		})
		return 'dry_run'
	}

	try {
		const invoiceId = await createOverageInvoice({
			env: input.env,
			userId: input.user.stable_user_id,
			plan,
			ladder,
			customerId,
			month: input.month,
			overage,
		})
		await upsertLedgerRow({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			month: input.month,
			overage,
			disposition,
			status: 'invoiced',
			stripeCustomerId: customerId,
			stripeInvoiceId: invoiceId,
			nowIso,
		})
		return 'invoiced'
	} catch (error) {
		console.error('compute_overage_invoice_failed', {
			month: input.month,
			error: error instanceof Error ? error.message : String(error),
		})
		await upsertLedgerRow({
			db: input.env.APP_DB,
			userId: input.user.stable_user_id,
			month: input.month,
			overage,
			disposition,
			status: 'failed',
			stripeCustomerId: customerId,
			stripeInvoiceId: existing?.stripe_invoice_id ?? null,
			nowIso,
		})
		return 'failed'
	}
}

async function createOverageInvoice(input: {
	env: Env
	userId: string
	plan: PlanName
	ladder: EntitlementLadder
	customerId: string
	month: string
	overage: MonthlyComputeOverage
}): Promise<string> {
	const metadata = {
		[computeOverageInvoiceMetadataKey]: '1',
		[computeOverageInvoiceMonthMetadataKey]: input.month,
		kody_stable_user_id: input.userId,
		kody_plan: input.plan,
		kody_ladder: input.ladder,
	}
	const invoice = await createDraftInvoice(input.env, {
		customerId: input.customerId,
		idempotencyKey: `kody-overage-invoice:${input.userId}:${input.month}`,
		metadata,
	})
	if (input.overage.uniqueWorkerDayCents > 0) {
		await createInvoiceItem(input.env, {
			customerId: input.customerId,
			invoiceId: invoice.id,
			amountCents: input.overage.uniqueWorkerDayCents,
			description: `Kody unique worker-day overage (${input.month}): ${input.overage.billableUniqueWorkerDays} days above include`,
			idempotencyKey: `kody-overage-uwd:${input.userId}:${input.month}`,
			metadata,
		})
	}
	if (input.overage.durableObjectRowsReadCents > 0) {
		await createInvoiceItem(input.env, {
			customerId: input.customerId,
			invoiceId: invoice.id,
			amountCents: input.overage.durableObjectRowsReadCents,
			description: `Kody Durable Object rows-read overage (${input.month}): ${input.overage.billableDurableObjectRowsRead} rows above include`,
			idempotencyKey: `kody-overage-dorows:${input.userId}:${input.month}`,
			metadata,
		})
	}
	await finalizeInvoice(
		input.env,
		invoice.id,
		`kody-overage-finalize:${input.userId}:${input.month}`,
	)
	await payInvoice(
		input.env,
		invoice.id,
		`kody-overage-pay:${input.userId}:${input.month}`,
	)
	return invoice.id
}

async function upsertLedgerRow(input: {
	db: D1Database
	userId: string
	month: string
	overage: MonthlyComputeOverage
	disposition: ComputeOverageDisposition
	status: ComputeOverageInvoiceStatus
	stripeCustomerId: string | null
	stripeInvoiceId: string | null
	nowIso: string
}) {
	await input.db
		.prepare(
			`INSERT INTO compute_overage_invoices (
				user_id, month,
				unique_worker_days, unique_worker_day_cents,
				durable_object_rows_read, durable_object_rows_read_cents,
				total_cents, disposition, status,
				stripe_customer_id, stripe_invoice_id,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id, month) DO UPDATE SET
				unique_worker_days = excluded.unique_worker_days,
				unique_worker_day_cents = excluded.unique_worker_day_cents,
				durable_object_rows_read = excluded.durable_object_rows_read,
				durable_object_rows_read_cents = excluded.durable_object_rows_read_cents,
				total_cents = excluded.total_cents,
				disposition = excluded.disposition,
				status = excluded.status,
				stripe_customer_id = excluded.stripe_customer_id,
				stripe_invoice_id = excluded.stripe_invoice_id,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.month,
			input.overage.billableUniqueWorkerDays +
				input.overage.includedUniqueWorkerDays,
			input.overage.uniqueWorkerDayCents,
			input.overage.billableDurableObjectRowsRead +
				input.overage.includedDurableObjectRowsRead,
			input.overage.durableObjectRowsReadCents,
			input.overage.totalCents,
			input.disposition,
			input.status,
			input.stripeCustomerId,
			input.stripeInvoiceId,
			input.nowIso,
			input.nowIso,
		)
		.run()
}
