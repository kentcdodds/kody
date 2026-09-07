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
	unique_worker_days: 'Unique worker days',
	durable_object_rows_read: 'Durable Object rows read',
} as const satisfies Record<ComputeOverageWarningResource, string>

export type ComputeOverageResourceVisibility = {
	group: 'monthly'
	kind: 'counter'
	whatCounts: string
	howToReduce: string
}

/**
 * Plain-language copy for account usage UI, `usageGet`, warning emails,
 * and compute-include denials. Keep factual and terse; update when
 * overage policy changes. Not a hard entitlement — see
 * {@link computeMeteringPolicy} / {@link resolveComputeOverageDisposition}.
 */
export const computeOverageResourceVisibility = {
	unique_worker_days: {
		group: 'monthly',
		kind: 'counter',
		whatCounts:
			'Counts distinct Cloudflare Dynamic Worker isolates (worker id + code) that run on a given UTC day, rolled up for the month. Reusing the same warm isolate typically does not add another day.',
		howToReduce:
			'Keep package code stable so isolates stay warm, and consolidate one-off execute runs into saved packages or jobs.',
	},
	durable_object_rows_read: {
		group: 'monthly',
		kind: 'counter',
		whatCounts:
			'SQLite rows read by your Durable Object package storage this UTC month.',
		howToReduce:
			'Read less from package storage, cache repeated queries, or upgrade your plan.',
	},
} as const satisfies Record<
	ComputeOverageWarningResource,
	ComputeOverageResourceVisibility
>

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

/**
 * Actionable reduction + billing next step for one monthly compute meter.
 * Disposition is optional: omit it for the generic under-include prompt.
 */
export function buildComputeOverageHowToReduce(
	resource: ComputeOverageWarningResource,
	disposition?: ComputeOverageDisposition | null,
): string {
	const base = computeOverageResourceVisibility[resource].howToReduce
	const billing = computeOverageBillingGuidance(resource, disposition)
	return billing ? `${base} ${billing}` : base
}

function computeOverageBillingGuidance(
	resource: ComputeOverageWarningResource,
	disposition?: ComputeOverageDisposition | null,
): string {
	const uniqueWorkerDayRate = `$${computeOverageRatesUsd.uniqueWorkerDay}`
	const rowsReadRate = `$${computeOverageRatesUsd.durableObjectRowsReadPerMillion} per million`
	switch (disposition) {
		case 'soft_block':
			return 'Upgrade your plan or add a payment method at /account/billing. Free accounts without a payment method are asked to upgrade instead of being charged for overage.'
		case 'invoice':
			return resource === 'unique_worker_days'
				? `Usage above this month's include is billed at ${uniqueWorkerDayRate} per unique worker day after the UTC month closes.`
				: `Usage above this month's include is billed at ${rowsReadRate} rows read after the UTC month closes.`
		case 'skip_legacy':
			return 'Legacy Standard and Pro are not billed for this overage. Changing plan moves you onto public rates.'
		case 'dry_run':
			return 'Overage is being recorded but is not billed while charging is paused.'
		case 'skip_below_minimum':
			return resource === 'unique_worker_days'
				? `Public-ladder overage is billed at ${uniqueWorkerDayRate} per unique worker day when a payment method is on file. Amounts below Stripe's $0.50 minimum are not invoiced.`
				: `Public-ladder overage is billed at ${rowsReadRate} rows read when a payment method is on file. Amounts below Stripe's $0.50 minimum are not invoiced.`
		case 'skip_zero':
		case 'skip_audience':
		case undefined:
		case null:
			return resource === 'unique_worker_days'
				? `Upgrade your plan for a higher include, or add a payment method to continue on public-ladder overage at ${uniqueWorkerDayRate} per unique worker day.`
				: 'Upgrade your plan for a higher include, or add a payment method to continue on public-ladder overage.'
		default: {
			const exhaustive: never = disposition
			throw new Error(
				`Unknown compute overage disposition: ${String(exhaustive)}`,
			)
		}
	}
}

/** Previous UTC `YYYY-MM` for a clock instant. */
export function previousUtcMonthKey(now: Date): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
		.toISOString()
		.slice(0, 'YYYY-MM'.length)
}
