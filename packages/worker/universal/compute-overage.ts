/**
 * Monthly unique-worker-day and Durable Object rows-read include math and
 * the credits guidance shown next to those meters. Includes live on
 * {@link resolvePlanLimits}; debit rates on `credits.ts`.
 *
 * Nobody is invoiced for usage above an include. A funded purchasable-Pro
 * wallet is debited for it (`billing/credit-debits.ts`); every other
 * account is not charged, bounded by its hard rate caps.
 */
import {
	creditDebitCostMicroUsd,
	creditDebitRates,
	type CreditDebitMeter,
} from './credits.ts'
import {
	creditsUnlockedResources,
	type CreditWalletState,
	type EntitlementLadder,
	type PlanName,
	resolvePlanLimits,
} from './plans.ts'

/** Where to add credits (or switch to Pro first). */
export const accountCreditsPath = '/account/credits'

/**
 * Credits state for one monthly meter:
 * - `within_include` — at or under the include.
 * - `debiting_credits` — above the include; the funded wallet pays.
 * - `add_credits` — above the include on Pro with an empty wallet.
 * - `switch_to_pro` — above the include on Free or retired Standard/Pro
 *   (no wallet; not charged).
 * - `not_charged` — above the include on an operator plan (`max`).
 */
const computeIncludeCreditsStatuses = [
	'within_include',
	'debiting_credits',
	'add_credits',
	'switch_to_pro',
	'not_charged',
] as const

export type ComputeIncludeCreditsStatus =
	(typeof computeIncludeCreditsStatuses)[number]

export const computeOverageWarningResources = [
	'unique_worker_days',
	'durable_object_rows_read',
] as const satisfies ReadonlyArray<CreditDebitMeter>

export type ComputeOverageWarningResource =
	(typeof computeOverageWarningResources)[number]

export const computeOverageWarningResourceLabels = {
	unique_worker_days: 'Unique worker days',
	durable_object_rows_read: 'Durable Object rows read',
} as const satisfies Record<ComputeOverageWarningResource, string>

/**
 * Factual mechanic line for hot unique-worker-day entitlement/limit
 * payloads. Meter name plus what a unique worker day is — not a playbook.
 */
export const uniqueWorkerDayMechanic =
	'Meter unique_worker_days: one unique Dynamic Worker isolate (worker id) per UTC day.'

export type ComputeOverageResourceVisibility = {
	group: 'monthly'
	kind: 'counter'
	whatCounts: string
	howToReduce: string
}

/**
 * Plain-language copy for account usage UI, `usageGet`, warning emails,
 * and compute-include denials. Keep factual and terse.
 */
export const computeOverageResourceVisibility = {
	unique_worker_days: {
		group: 'monthly',
		kind: 'counter',
		whatCounts:
			'Counts distinct Cloudflare Dynamic Worker isolates (worker id + code) that run on a given UTC day, rolled up for the month. Reusing the same warm isolate typically does not add another day.',
		howToReduce:
			'Keep package code stable so isolates stay warm. For ad hoc execute, reuse the same module graph and vary args via params. Consolidate one-off execute runs into saved packages or jobs.',
	},
	durable_object_rows_read: {
		group: 'monthly',
		kind: 'counter',
		whatCounts:
			'SQLite rows read by your Durable Object package storage this UTC month.',
		howToReduce: 'Read less from package storage, cache repeated queries.',
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
	/**
	 * Cumulative credits cost of this month's usage above the include at
	 * the debit rates. Only debited from a funded wallet.
	 */
	creditsCostMicroUsd: number
}

function nonNegativeInteger(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0
	return Math.trunc(value)
}

/** Include-then-credits amounts for one UTC month. */
export function computeMonthlyOverage(input: {
	plan: PlanName
	ladder: EntitlementLadder
	creditWallet: CreditWalletState
	uniqueWorkerDays: number
	durableObjectRowsRead: number
}): MonthlyComputeOverage {
	const limits = resolvePlanLimits(input.plan, input.ladder, input.creditWallet)
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
	return {
		includedUniqueWorkerDays,
		includedDurableObjectRowsRead,
		billableUniqueWorkerDays,
		billableDurableObjectRowsRead,
		creditsCostMicroUsd:
			creditDebitCostMicroUsd('unique_worker_days', billableUniqueWorkerDays) +
			creditDebitCostMicroUsd(
				'durable_object_rows_read',
				billableDurableObjectRowsRead,
			),
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

export function resolveComputeIncludeCreditsStatus(input: {
	plan: PlanName
	creditWallet: CreditWalletState
	pastInclude: boolean
}): ComputeIncludeCreditsStatus {
	if (!input.pastInclude) return 'within_include'
	switch (input.creditWallet) {
		case 'funded':
			return 'debiting_credits'
		case 'empty':
			return 'add_credits'
		case 'none':
			return input.plan === 'max' ? 'not_charged' : 'switch_to_pro'
		default: {
			const exhaustive: never = input.creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}

/**
 * Reduction advice plus the credits next step for one monthly meter.
 * Every non-operator account points at {@link accountCreditsPath}; Free and
 * retired plans land there on the switch-to-Pro prompt.
 */
export function buildComputeOverageHowToReduce(
	resource: ComputeOverageWarningResource,
	plan: PlanName,
	creditWallet: CreditWalletState,
): string {
	const base = computeOverageResourceVisibility[resource].howToReduce
	const guidance = computeOverageCreditsGuidance(resource, plan, creditWallet)
	return guidance ? `${base} ${guidance}` : base
}

function computeOverageCreditsGuidance(
	resource: ComputeOverageWarningResource,
	plan: PlanName,
	creditWallet: CreditWalletState,
): string {
	const rate = creditDebitRates[resource].label
	switch (creditWallet) {
		case 'funded':
			return `Usage above the include debits your credits at ${rate}.`
		case 'empty':
			return `Credits at ${accountCreditsPath} lift hard caps; usage above the include then debits ${rate}.`
		case 'none':
			if (plan === 'max') return ''
			return plan === 'free'
				? `Switch to Pro at ${accountCreditsPath} for a larger include and prepaid credits.`
				: `Usage above the include is not charged on your plan. Switch to Pro at ${accountCreditsPath} to add credits.`
		default: {
			const exhaustive: never = creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}

/**
 * Credits only help rate/compute limits a funded wallet raises and the
 * monthly compute meters it pays for; stock, email, storage, and
 * concurrency warnings get no credits link.
 */
export function warningOffersCredits(resource: string): boolean {
	return (
		(creditsUnlockedResources as ReadonlyArray<string>).includes(resource) ||
		(computeOverageWarningResources as ReadonlyArray<string>).includes(resource)
	)
}
