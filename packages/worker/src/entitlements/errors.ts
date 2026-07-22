import {
	entitlementResourceLabels,
	parsePlanName,
	type EntitlementResource,
	type PlanName,
} from './plans.ts'

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
	return `Remove or finish existing ${label} you no longer need, or ask the operator of this Kody deployment to upgrade your plan.`
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

function escapeRegex(value: string) {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
