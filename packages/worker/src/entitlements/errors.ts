import {
	entitlementResourceLabels,
	formatMinJobInterval,
	parsePlanName,
	type EntitlementResource,
	type PlanName,
} from '#universal/plans.ts'

export const entitlementLimitErrorCode = 'entitlement_limit_exceeded' as const

export type EntitlementLimitErrorDetails = {
	code: typeof entitlementLimitErrorCode
	resource: EntitlementResource
	/** Always a known plan name (including `max` when plan lookup short-circuits). */
	plan: PlanName
	limit: number
	current: number
	upgradeHint: string
}

export function buildEntitlementUpgradeHint(resource: EntitlementResource) {
	const label = entitlementResourceLabels[resource]
	return `Remove or finish existing ${label} you no longer need, or upgrade your plan at /account/billing.`
}

/**
 * The one user-facing message format for every entitlement denial, across
 * MCP and UI surfaces. Keep changes here only; enforcement points must not
 * compose their own messages.
 */
export function buildEntitlementLimitMessage(
	details: EntitlementLimitErrorDetails,
) {
	const label = entitlementResourceLabels[details.resource]
	return `Plan limit reached: your "${details.plan}" plan allows at most ${details.limit} ${label} and you currently have ${details.current}. ${details.upgradeHint}`
}

export function parseEntitlementLimitMessage(
	message: string,
): EntitlementLimitErrorDetails | null {
	for (const [resource, label] of Object.entries(
		entitlementResourceLabels,
	) as Array<[EntitlementResource, string]>) {
		const match = new RegExp(
			`^Plan limit reached: your "([^"]+)" plan allows at most (\\d+) ${escapeRegex(label)} and you currently have (\\d+)\\. (.+)$`,
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
			resource,
			plan,
			limit,
			current,
			upgradeHint: match[4] ?? '',
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

export function buildJobIntervalFloorUpgradeHint() {
	return 'Space this job out, or upgrade at /account/billing.'
}

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

export class JobIntervalFloorError extends Error {
	readonly details: JobIntervalFloorErrorDetails

	constructor(
		details: Omit<JobIntervalFloorErrorDetails, 'code' | 'upgradeHint'> & {
			upgradeHint?: string
		},
	) {
		const fullDetails: JobIntervalFloorErrorDetails = {
			code: jobIntervalFloorErrorCode,
			upgradeHint: details.upgradeHint ?? buildJobIntervalFloorUpgradeHint(),
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
