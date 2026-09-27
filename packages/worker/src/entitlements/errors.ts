import {
	accountCreditsPath,
	buildComputeOverageCreditsGuidance,
	computeOverageResourceVisibility,
	computeOverageUnitLabels,
	computeOverageWarningResourceLabels,
	type ComputeIncludeCreditsStatus,
	type ComputeOverageWarningResource,
} from '#universal/compute-overage.ts'
import {
	entitlementResourceLabels,
	formatMinJobInterval,
	hasHigherPublicPlan,
	isCreditsUnlockedResource,
	isWeeklyComputeWindowResource,
	type CreditWalletState,
	parsePlanName,
	weeklyEntitlementResourceLabel,
	type EntitlementResource,
	type PlanName,
	type WeeklyComputeWindowResource,
} from '#universal/plans.ts'

export const entitlementLimitErrorCode = 'entitlement_limit_exceeded' as const

export type EntitlementLimitWindow = 'day' | 'week'

export type EntitlementLimitErrorDetails = {
	code: typeof entitlementLimitErrorCode
	resource: EntitlementResource
	/** Always a known plan name (including `max` when plan lookup short-circuits). */
	plan: PlanName
	limit: number
	current: number
	upgradeHint: string
	/** Which hard window blocked. Omit for stock/count resources. */
	window?: EntitlementLimitWindow
}

/**
 * Credits next step for a rate/compute include, or `null` when the plan's
 * ordinary upgrade/reduce guidance applies. Purchasable Pro at $0 is at its
 * include and keeps going on credits; a funded wallet is already at the
 * credits ceiling. Free keeps its hard caps (upgrade offer); retired and
 * gift Pro accounts learn that Pro with credits runs past the include.
 */
export function entitlementCreditsOffer(
	resource: EntitlementResource,
	plan: PlanName,
	creditWallet: CreditWalletState,
): string | null {
	if (!isCreditsUnlockedResource(resource) || plan === 'max') return null
	switch (creditWallet) {
		case 'empty':
			return `add credits at ${accountCreditsPath} to keep going past your include`
		case 'funded':
			return null
		case 'none':
			return hasHigherPublicPlan(plan)
				? null
				: `Pro with prepaid credits at ${accountCreditsPath} runs past its include`
		default: {
			const exhaustive: never = creditWallet
			throw new Error(`Unknown credit wallet state: ${String(exhaustive)}`)
		}
	}
}

/**
 * Next step appended to every entitlement denial. Stock is on the
 * purchasable Pro subscription, so it only offers an upgrade on Free.
 */
export function buildEntitlementUpgradeHint(
	resource: EntitlementResource,
	plan: PlanName,
	creditWallet: CreditWalletState = 'none',
) {
	const label = entitlementResourceLabels[resource]
	const reduceGuidance = `Remove or finish existing ${label} you no longer need.`
	const creditsOffer = entitlementCreditsOffer(resource, plan, creditWallet)
	if (creditsOffer) {
		return `${reduceGuidance.slice(0, -1)}, or ${creditsOffer}.`
	}
	if (!hasHigherPublicPlan(plan)) return reduceGuidance
	return `${reduceGuidance.slice(0, -1)}, or upgrade your plan at /account/billing.`
}

/**
 * The one user-facing message format for every entitlement denial, across
 * MCP and UI surfaces. Keep changes here only; enforcement points must not
 * compose their own messages.
 */
function entitlementLimitLabel(
	resource: EntitlementResource,
	window: EntitlementLimitWindow | undefined,
) {
	if (window === 'week' && isWeeklyComputeWindowResource(resource)) {
		return weeklyEntitlementResourceLabel(resource)
	}
	return entitlementResourceLabels[resource]
}

export function buildEntitlementLimitMessage(
	details: EntitlementLimitErrorDetails,
) {
	const label = entitlementLimitLabel(details.resource, details.window)
	return `Plan limit reached: your "${details.plan}" plan allows at most ${details.limit} ${label} and you currently have ${details.current}. ${details.upgradeHint}`
}

export function parseEntitlementLimitMessage(
	message: string,
): EntitlementLimitErrorDetails | null {
	const weeklyLabels = (
		['execute_calls_per_day', 'outbound_fetches_per_day'] as const
	).map((resource) => ({
		resource: resource satisfies WeeklyComputeWindowResource,
		label: weeklyEntitlementResourceLabel(resource),
		window: 'week' as const,
	}))
	const dailyLabels = (
		Object.entries(entitlementResourceLabels) as Array<
			[EntitlementResource, string]
		>
	).map(([resource, label]) => ({
		resource,
		label,
		window: undefined as EntitlementLimitWindow | undefined,
	}))
	// Weekly labels first so "this week" is not swallowed by "per day".
	for (const entry of [...weeklyLabels, ...dailyLabels]) {
		const match = new RegExp(
			`^Plan limit reached: your "([^"]+)" plan allows at most (\\d+) ${escapeRegex(entry.label)} and you currently have (\\d+)\\. (.+)$`,
		).exec(message)
		if (!match) continue

		const plan = parsePlanName(match[1])
		if (!plan) return null
		const limit = Number(match[2])
		const current = Number(match[3])
		if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(current)) {
			return null
		}

		return {
			code: entitlementLimitErrorCode,
			resource: entry.resource,
			plan,
			limit,
			current,
			upgradeHint: match[4] ?? '',
			...(entry.window ? { window: entry.window } : {}),
		}
	}
	return null
}

export class EntitlementLimitError extends Error {
	readonly details: EntitlementLimitErrorDetails

	constructor(details: Omit<EntitlementLimitErrorDetails, 'code'>) {
		const fullDetails: EntitlementLimitErrorDetails = {
			code: entitlementLimitErrorCode,
			...details,
		}
		super(buildEntitlementLimitMessage(fullDetails))
		this.name = 'EntitlementLimitError'
		this.details = fullDetails
	}
}

export function isEntitlementLimitError(
	error: unknown,
): error is EntitlementLimitError {
	return (
		error instanceof EntitlementLimitError ||
		(error instanceof Error &&
			'details' in error &&
			typeof error.details === 'object' &&
			error.details !== null &&
			'code' in error.details &&
			error.details.code === entitlementLimitErrorCode)
	)
}

export const jobIntervalFloorErrorCode = 'job_interval_floor' as const

export type JobIntervalFloorErrorDetails = {
	code: typeof jobIntervalFloorErrorCode
	plan: PlanName
	minIntervalMs: number
	upgradeHint: string
}

/** Free and Pro share the 15-minute floor, so there is no upgrade offer. */
export const jobIntervalFloorUpgradeHint = 'Space this job out.'

export function buildJobIntervalFloorMessage(
	details: JobIntervalFloorErrorDetails,
) {
	const interval = formatMinJobInterval(details.minIntervalMs)
	return `Your "${details.plan}" plan cannot run jobs more often than every ${interval}. ${details.upgradeHint}`
}

export function parseJobIntervalFloorMessage(
	message: string,
): JobIntervalFloorErrorDetails | null {
	const match =
		/^Your "([^"]+)" plan cannot run jobs more often than every (.*?)\. (.*)$/.exec(
			message,
		)
	if (!match) return null
	const plan = parsePlanName(match[1])
	if (!plan) return null
	const minIntervalMs = parseFormattedMinJobInterval(match[2] ?? '')
	if (minIntervalMs === null) return null
	return {
		code: jobIntervalFloorErrorCode,
		plan,
		minIntervalMs,
		upgradeHint: match[3] ?? '',
	}
}

function parseFormattedMinJobInterval(interval: string) {
	if (interval === 'None') return 0
	if (interval === '1 hour') return 60 * 60 * 1000
	if (interval === '1 minute') return 60 * 1000
	const hours = /^(\d+) hours$/.exec(interval)
	if (hours) {
		const value = Number(hours[1])
		if (!Number.isSafeInteger(value) || value < 1) return null
		return value * 60 * 60 * 1000
	}
	const minutes = /^(\d+) minutes$/.exec(interval)
	if (minutes) {
		const value = Number(minutes[1])
		if (!Number.isSafeInteger(value) || value < 1) return null
		return value * 60 * 1000
	}
	const milliseconds = /^(\d+) ms$/.exec(interval)
	if (milliseconds) {
		const value = Number(milliseconds[1])
		if (!Number.isSafeInteger(value) || value < 1) return null
		return value
	}
	return null
}

export const computeOverageLimitErrorCode =
	'compute_overage_include_reached' as const

export type ComputeOverageLimitErrorDetails = {
	code: typeof computeOverageLimitErrorCode
	resource: ComputeOverageWarningResource
	plan: PlanName
	limit: number
	current: number
	whatCounts: string
	upgradeHint: string
	creditsStatus: ComputeIncludeCreditsStatus
}

function creditWalletForStatus(
	status: ComputeIncludeCreditsStatus,
): CreditWalletState {
	switch (status) {
		case 'debiting_credits':
			return 'funded'
		case 'add_credits':
			return 'empty'
		case 'within_include':
		case 'switch_to_pro':
		case 'not_charged':
			return 'none'
		default: {
			const exhaustive: never = status
			throw new Error(`Unknown credits status: ${String(exhaustive)}`)
		}
	}
}

/**
 * User-facing stop when an empty purchasable-Pro wallet has used up a
 * monthly Worker compute or Rows read include. Enforcement points must not
 * compose their own messages.
 */
export function buildComputeOverageLimitMessage(
	details: ComputeOverageLimitErrorDetails,
) {
	const label = computeOverageWarningResourceLabels[details.resource]
	const unit = computeOverageUnitLabels[details.resource]
	return `${label} include used up: your "${details.plan}" plan includes ${formatCount(details.limit)} ${unit} this UTC month and you have used ${formatCount(details.current)}. ${details.upgradeHint}`
}

export function parseComputeOverageLimitMessage(
	message: string,
): ComputeOverageLimitErrorDetails | null {
	for (const resource of Object.keys(
		computeOverageWarningResourceLabels,
	) as Array<ComputeOverageWarningResource>) {
		const label = computeOverageWarningResourceLabels[resource]
		const unit = computeOverageUnitLabels[resource]
		const match = new RegExp(
			`^${escapeRegex(label)} include used up: your "([^"]+)" plan includes ([\\d,]+) ${escapeRegex(unit)} this UTC month and you have used ([\\d,]+)\\. (.+)$`,
		).exec(message)
		if (!match) continue

		const plan = parsePlanName(match[1])
		if (!plan) return null
		const limit = parseCount(match[2])
		const current = parseCount(match[3])
		if (limit === null || current === null) return null
		return {
			code: computeOverageLimitErrorCode,
			resource,
			plan,
			limit,
			current,
			whatCounts: computeOverageResourceVisibility[resource].whatCounts,
			upgradeHint: match[4] ?? '',
			creditsStatus: 'add_credits',
		}
	}
	return null
}

function formatCount(value: number) {
	return value.toLocaleString('en-US')
}

function parseCount(value: string | undefined) {
	const count = Number((value ?? '').replaceAll(',', ''))
	return Number.isSafeInteger(count) ? count : null
}

export class ComputeOverageLimitError extends Error {
	readonly details: ComputeOverageLimitErrorDetails

	constructor(
		details: Omit<
			ComputeOverageLimitErrorDetails,
			'code' | 'whatCounts' | 'upgradeHint'
		> & {
			whatCounts?: string
			upgradeHint?: string
		},
	) {
		const visibility = computeOverageResourceVisibility[details.resource]
		const guidance = buildComputeOverageCreditsGuidance(
			details.resource,
			details.plan,
			creditWalletForStatus(details.creditsStatus),
		)
		const fullDetails: ComputeOverageLimitErrorDetails = {
			code: computeOverageLimitErrorCode,
			resource: details.resource,
			plan: details.plan,
			limit: details.limit,
			current: details.current,
			whatCounts: details.whatCounts ?? visibility.whatCounts,
			upgradeHint:
				details.upgradeHint ??
				(guidance
					? `${guidance} ${visibility.howToReduce}`
					: visibility.howToReduce),
			creditsStatus: details.creditsStatus,
		}
		super(buildComputeOverageLimitMessage(fullDetails))
		this.name = 'ComputeOverageLimitError'
		this.details = fullDetails
	}
}

export function isComputeOverageLimitError(
	error: unknown,
): error is ComputeOverageLimitError {
	return (
		error instanceof ComputeOverageLimitError ||
		(error instanceof Error &&
			'details' in error &&
			typeof error.details === 'object' &&
			error.details !== null &&
			'code' in error.details &&
			error.details.code === computeOverageLimitErrorCode)
	)
}

export class JobIntervalFloorError extends Error {
	readonly details: JobIntervalFloorErrorDetails

	constructor(
		details: Omit<JobIntervalFloorErrorDetails, 'code' | 'upgradeHint'> & {
			upgradeHint?: string
		},
	) {
		const fullDetails: JobIntervalFloorErrorDetails = {
			code: jobIntervalFloorErrorCode,
			upgradeHint: details.upgradeHint ?? jobIntervalFloorUpgradeHint,
			plan: details.plan,
			minIntervalMs: details.minIntervalMs,
		}
		super(buildJobIntervalFloorMessage(fullDetails))
		this.name = 'JobIntervalFloorError'
		this.details = fullDetails
	}
}

export function isJobIntervalFloorError(
	error: unknown,
): error is JobIntervalFloorError {
	return (
		error instanceof JobIntervalFloorError ||
		(error instanceof Error &&
			'details' in error &&
			typeof error.details === 'object' &&
			error.details !== null &&
			'code' in error.details &&
			error.details.code === jobIntervalFloorErrorCode)
	)
}

function escapeRegex(value: string) {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
