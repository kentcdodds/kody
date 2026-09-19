import {
	isSearchRateLimitError,
	searchRateLimitErrorCode,
} from '#worker/search-rate-limit.ts'

/**
 * Machine-readable abuse rate-limit fields for MCP tool structured content.
 * Parallel to entitlement metadata, but never uses the `entitlement` key —
 * search rate limits are not plan quotas.
 */
export type McpRateLimitMetadata = {
	code: typeof searchRateLimitErrorCode
	window: 'burst' | 'day'
	retryAfterSeconds: number
	limit: number
	plan: string
}

export function toMcpRateLimitMetadata(
	error: unknown,
): McpRateLimitMetadata | undefined {
	if (!isSearchRateLimitError(error)) return undefined
	return {
		code: searchRateLimitErrorCode,
		window: error.window,
		retryAfterSeconds: error.retryAfterSeconds,
		limit: error.limit,
		plan: error.plan,
	}
}

/**
 * Spread onto MCP `structuredContent` only when the error is a search
 * abuse rate-limit denial. Ordinary successes and unrelated errors stay
 * unchanged (no `rateLimit` key).
 */
export function rateLimitStructuredContent(error: unknown) {
	const rateLimit = toMcpRateLimitMetadata(error)
	return rateLimit ? { rateLimit } : {}
}
