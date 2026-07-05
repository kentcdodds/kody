import {
	entitlementResourceLabels,
	type EntitlementResource,
	type PlanName,
} from './plans.ts'

export const entitlementLimitErrorCode = 'entitlement_limit_exceeded' as const

export type EntitlementLimitErrorDetails = {
	code: typeof entitlementLimitErrorCode
	resource: EntitlementResource
	/** null when the limit came from a global fallback rather than a plan. */
	plan: PlanName | null
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
	const planText = details.plan
		? `your "${details.plan}" plan`
		: 'this deployment'
	return `Plan limit reached: ${planText} allows at most ${details.limit} ${label} and you currently have ${details.current}. ${details.upgradeHint}`
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
