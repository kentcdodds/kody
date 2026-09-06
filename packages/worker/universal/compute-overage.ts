/**
 * Monthly unique-worker-day and Durable Object rows-read overage math and
 * who-to-bill policy. List rates and includes live on
 * {@link computeOverageRatesUsd} / {@link resolvePlanLimits}.
 *
 * This module does not talk to Stripe. Execute and Durable Object duration
 * are not meters here. Legacy Standard/Pro stays
 * {@link computeMeteringPolicy.legacyMonthlyMeters} (`no_cut_no_bill`).
 *
 * Public-ladder accounts are the billed audience. Unpaid Free is a
 * soft-block (upgrade prompt), never a Stripe charge that would fail.
 * Changing the audience later is {@link computeOverageBillingPolicy} plus
 * the `compute-overage-charging` flag — not a rewrite of include math.
 */
import {
	computeMeteringPolicy,
	computeOverageRatesUsd,
	type EntitlementLadder,
	type PlanName,
	resolvePlanLimits,
} from './plans.ts'

const centsPerUsd = 100
const durableObjectRowsPerMillion = 1_000_000

/**
 * Decided billed audience is `public` (Free, Standard, Pro, and max on
 * the public ladder). `everyone` remains a later switch; it still cannot
 * invoice legacy while `chargeLegacy` is false.
 */
export const computeOverageBillAudiences = ['public', 'everyone'] as const

export type ComputeOverageBillAudience =
	(typeof computeOverageBillAudiences)[number]

export const computeOverageBillingPolicy = {
	audience: 'public',
	/**
	 * Locked to `no_cut_no_bill`. Do not set true without Felix/Kent.
	 */
	chargeLegacy: false,
} as const satisfies {
	audience: ComputeOverageBillAudience
	chargeLegacy: boolean
}

export type ComputeOverageDisposition =
	| 'invoice'
	| 'soft_block'
	| 'dry_run'
	| 'skip_legacy'
	| 'skip_zero'
	| 'skip_below_minimum'
	| 'skip_audience'

/** Stripe's USD charge minimum. Below this, `payInvoice` always fails. */
export const stripeUsdMinimumChargeCents = 50

export const computeOverageWarningResources = [
	'unique_worker_days',
	'durable_object_rows_read',
] as const

export type ComputeOverageWarningResource =
	(typeof computeOverageWarningResources)[number]

export const computeOverageWarningResourceLabels = {
	unique_worker_days: 'unique worker-days',
	durable_object_rows_read: 'Durable Object rows read',
} as const satisfies Record<ComputeOverageWarningResource, string>

export type MonthlyComputeOverage = {
	includedUniqueWorkerDays: number
	includedDurableObjectRowsRead: number
	billableUniqueWorkerDays: number
	billableDurableObjectRowsRead: number
	uniqueWorkerDayUsd: number
	durableObjectRowsReadUsd: number
	uniqueWorkerDayCents: number
	durableObjectRowsReadCents: number
	totalCents: number
	legacyUnbilled: boolean
}

export type ComputeOverageDispositionInput = {
	plan: PlanName
	ladder: EntitlementLadder
	overage: MonthlyComputeOverage
	hasStripeCustomer: boolean
	chargingEnabled: boolean
	policy?: typeof computeOverageBillingPolicy
}

function nonNegativeInteger(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0
	return Math.trunc(value)
}

function usdToCents(usd: number): number {
	if (!Number.isFinite(usd) || usd <= 0) return 0
	return Math.round(usd * centsPerUsd)
}

function isLegacyUnbilled(plan: PlanName, ladder: EntitlementLadder): boolean {
	return (
		ladder === 'legacy' &&
		(plan === 'standard' || plan === 'pro') &&
		computeMeteringPolicy.legacyMonthlyMeters === 'no_cut_no_bill'
	)
}

function matchesBillAudience(input: {
	plan: PlanName
	ladder: EntitlementLadder
	audience: ComputeOverageBillAudience
}): boolean {
	switch (input.audience) {
		case 'public':
			return input.ladder === 'public'
		case 'everyone':
			return true
		default: {
			const exhaustive: never = input.audience
			throw new Error(
				`Unknown compute overage bill audience: ${String(exhaustive)}`,
			)
		}
	}
}

/**
 * Included-then-overage amounts for one UTC month. Always computes the
 * display math, including for legacy (which stays unbilled).
 */
export function computeMonthlyOverage(input: {
	plan: PlanName
	ladder: EntitlementLadder
	uniqueWorkerDays: number
	durableObjectRowsRead: number
}): MonthlyComputeOverage {
	const limits = resolvePlanLimits(input.plan, input.ladder)
	const uniqueWorkerDays = nonNegativeInteger(input.uniqueWorkerDays)
	const durableObjectRowsRead = nonNegativeInteger(input.durableObjectRowsRead)
	const includedUniqueWorkerDays = limits.maxUniqueWorkerDaysPerMonth
	const includedDurableObjectRowsRead = limits.maxDurableObjectRowsReadPerMonth
	const billableUniqueWorkerDays = Math.max(
		0,
		uniqueWorkerDays - includedUniqueWorkerDays,
	)
	const billableDurableObjectRowsRead = Math.max(
		0,
		durableObjectRowsRead - includedDurableObjectRowsRead,
	)
	const uniqueWorkerDayUsd =
		billableUniqueWorkerDays * computeOverageRatesUsd.uniqueWorkerDay
	const durableObjectRowsReadUsd =
		(billableDurableObjectRowsRead / durableObjectRowsPerMillion) *
		computeOverageRatesUsd.durableObjectRowsReadPerMillion
	return {
		includedUniqueWorkerDays,
		includedDurableObjectRowsRead,
		billableUniqueWorkerDays,
		billableDurableObjectRowsRead,
		uniqueWorkerDayUsd,
		durableObjectRowsReadUsd,
		uniqueWorkerDayCents: usdToCents(uniqueWorkerDayUsd),
		durableObjectRowsReadCents: usdToCents(durableObjectRowsReadUsd),
		totalCents:
			usdToCents(uniqueWorkerDayUsd) + usdToCents(durableObjectRowsReadUsd),
		legacyUnbilled: isLegacyUnbilled(input.plan, input.ladder),
	}
}

export function computeOverageIncludePercent(
	current: number,
	include: number,
): number | null {
	if (!Number.isFinite(current) || current < 0) return 0
	if (!Number.isFinite(include) || include <= 0) return current > 0 ? 1 : 0
	return current / include
}

/**
 * Decide whether this month's overage becomes a Stripe invoice, a Free
 * soft-block (upgrade prompt, no charge), a dry-run while the flag is
 * off, or a skip. Legacy never returns `invoice`.
 */
export function resolveComputeOverageDisposition(
	input: ComputeOverageDispositionInput,
): ComputeOverageDisposition {
	const policy = input.policy ?? computeOverageBillingPolicy
	if (input.overage.totalCents <= 0) return 'skip_zero'
	if (input.overage.legacyUnbilled && !policy.chargeLegacy) {
		return 'skip_legacy'
	}
	if (
		!matchesBillAudience({
			plan: input.plan,
			ladder: input.ladder,
			audience: policy.audience,
		})
	) {
		return 'skip_audience'
	}
	if (input.plan === 'free' && !input.hasStripeCustomer) {
		return 'soft_block'
	}
	if (!input.chargingEnabled) return 'dry_run'
	if (!input.hasStripeCustomer) return 'dry_run'
	if (input.overage.totalCents < stripeUsdMinimumChargeCents) {
		return 'skip_below_minimum'
	}
	return 'invoice'
}

/** Previous UTC `YYYY-MM` for a clock instant. */
export function previousUtcMonthKey(now: Date): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
		.toISOString()
		.slice(0, 'YYYY-MM'.length)
}
