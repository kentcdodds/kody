import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	entitlementLimitErrorCode,
	isEntitlementLimitError,
	isJobIntervalFloorError,
	jobIntervalFloorErrorCode,
	parseEntitlementLimitMessage,
	parseJobIntervalFloorMessage,
	type EntitlementLimitErrorDetails,
	type JobIntervalFloorErrorDetails,
} from '#worker/entitlements/errors.ts'
import { isDailyEntitlementResource } from '#worker/entitlements/user-meter-do.ts'

/**
 * Focused, machine-readable entitlement fields for MCP tool structured
 * content. Only known denial/quota fields — never secrets, prices, billing
 * records, or unrelated entitlements. Omitted from ordinary successes.
 */
export type McpEntitlementMetadata =
	| {
			code: typeof entitlementLimitErrorCode
			resource: EntitlementLimitErrorDetails['resource']
			plan: EntitlementLimitErrorDetails['plan']
			limit: number
			current: number
			upgradeHint: string
			used?: number
			remaining?: number
	  }
	| {
			code: typeof jobIntervalFloorErrorCode
			resource: 'scheduled_jobs'
			plan: JobIntervalFloorErrorDetails['plan']
			upgradeHint: string
			minIntervalMs: number
	  }

export function toMcpEntitlementMetadata(
	error: unknown,
): McpEntitlementMetadata | undefined {
	if (isEntitlementLimitError(error)) {
		return toEntitlementLimitMetadata(error.details)
	}
	if (isJobIntervalFloorError(error)) {
		return toJobIntervalMetadata(error.details)
	}

	const message = getErrorMessage(error)
	const entitlementDetails = parseEntitlementLimitMessage(message)
	if (entitlementDetails) return toEntitlementLimitMetadata(entitlementDetails)
	const intervalDetails = parseJobIntervalFloorMessage(message)
	if (intervalDetails) return toJobIntervalMetadata(intervalDetails)
	return undefined
}

/**
 * Spread onto MCP `structuredContent` only when the error is an entitlement
 * or plan-limit denial. Ordinary successes and unrelated errors stay
 * unchanged (no `entitlement` key).
 */
export function entitlementStructuredContent(error: unknown) {
	const entitlement = toMcpEntitlementMetadata(error)
	return entitlement ? { entitlement } : {}
}

function toEntitlementLimitMetadata(
	details: EntitlementLimitErrorDetails,
): McpEntitlementMetadata {
	const metadata = {
		code: entitlementLimitErrorCode,
		resource: details.resource,
		plan: details.plan,
		limit: details.limit,
		current: details.current,
		upgradeHint: details.upgradeHint,
	} as const
	if (!isDailyEntitlementResource(details.resource)) return metadata
	return {
		...metadata,
		used: details.current,
		remaining: Math.max(0, details.limit - details.current),
	}
}

function toJobIntervalMetadata(
	details: JobIntervalFloorErrorDetails,
): McpEntitlementMetadata {
	return {
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: details.plan,
		upgradeHint: details.upgradeHint,
		minIntervalMs: details.minIntervalMs,
	}
}
