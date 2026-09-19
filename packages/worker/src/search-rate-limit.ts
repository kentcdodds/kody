import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { type PlanName } from '#universal/plans.ts'
import { getUserPlan } from '#worker/entitlements/service.ts'

/**
 * Abuse-protection ceilings for MCP/meta search — not plan entitlements.
 * Search is intentionally absent from entitlement resources / usageGet; these
 * limits only stop DOW and runaway agent loops before embeddings / Jev burn.
 *
 * Tuned against sibling daily ladders (`maxExecuteCallsPerDay` 150 → 25_000,
 * `maxOutboundFetchesPerDay` 1_000 → 80_000): search is cheaper than execute
 * but still pays Workers AI (~$0.001/search with Jev). Burst is high enough
 * for tight agent search loops; daily is a soft DOW backstop.
 */
export const searchRateLimitByPlan = {
	free: {
		burst: { maxRequests: 40, windowSeconds: 60 },
		daily: { maxRequests: 1_000, windowSeconds: 60 * 60 * 24 },
	},
	standard: {
		burst: { maxRequests: 80, windowSeconds: 60 },
		daily: { maxRequests: 5_000, windowSeconds: 60 * 60 * 24 },
	},
	pro: {
		burst: { maxRequests: 100, windowSeconds: 60 },
		daily: { maxRequests: 10_000, windowSeconds: 60 * 60 * 24 },
	},
	max: {
		burst: { maxRequests: 120, windowSeconds: 60 },
		daily: { maxRequests: 25_000, windowSeconds: 60 * 60 * 24 },
	},
} as const satisfies Record<
	PlanName,
	{
		burst: { maxRequests: number; windowSeconds: number }
		daily: { maxRequests: number; windowSeconds: number }
	}
>

export type SearchRateLimitWindow = 'burst' | 'day'

export const searchRateLimitErrorCode = 'rate_limited' as const

export class SearchRateLimitError extends Error {
	readonly code = searchRateLimitErrorCode
	readonly window: SearchRateLimitWindow
	readonly retryAfterSeconds: number
	readonly limit: number
	readonly plan: PlanName

	constructor(input: {
		window: SearchRateLimitWindow
		retryAfterSeconds: number
		limit: number
		plan: PlanName
	}) {
		const windowLabel = input.window === 'burst' ? 'per-minute' : 'per-day'
		super(
			`Search rate limit exceeded (${windowLabel}; plan "${input.plan}" allows ${input.limit} searches ${windowLabel === 'per-minute' ? 'per minute' : 'per day'}). Retry after ${input.retryAfterSeconds} seconds. This is abuse protection, not a plan quota.`,
		)
		this.name = 'SearchRateLimitError'
		this.window = input.window
		this.retryAfterSeconds = input.retryAfterSeconds
		this.limit = input.limit
		this.plan = input.plan
	}
}

export function isSearchRateLimitError(
	error: unknown,
): error is SearchRateLimitError {
	return error instanceof SearchRateLimitError
}

export function searchBurstRateLimitKey(userId: string) {
	return `mcp-search-burst:user:${userId}`
}

export function searchDailyRateLimitKey(userId: string) {
	return `mcp-search-daily:user:${userId}`
}

/**
 * Consume burst + daily search slots for a signed-in user before paid AI
 * (embeddings / Jev). No-ops when `userId` is null (nothing to attribute).
 * If the daily window rejects after burst was consumed, the burst slot is
 * refunded so a day-cap trip does not also spend the minute budget.
 */
export async function consumeSearchRateLimit(input: {
	db: D1Database
	userId: string | null
	email: string | null | undefined
}): Promise<void> {
	if (!input.userId) return

	const plan = await getUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limits = searchRateLimitByPlan[plan]
	const burstKey = searchBurstRateLimitKey(input.userId)
	const dailyKey = searchDailyRateLimitKey(input.userId)

	const burst = await checkRateLimit(input.db, burstKey, limits.burst)
	if (!burst.allowed) {
		throw new SearchRateLimitError({
			window: 'burst',
			retryAfterSeconds: burst.retryAfterSeconds ?? limits.burst.windowSeconds,
			limit: limits.burst.maxRequests,
			plan,
		})
	}

	const daily = await checkRateLimit(input.db, dailyKey, limits.daily)
	if (!daily.allowed) {
		await releaseRateLimit(input.db, burstKey).catch(() => undefined)
		throw new SearchRateLimitError({
			window: 'day',
			retryAfterSeconds: daily.retryAfterSeconds ?? limits.daily.windowSeconds,
			limit: limits.daily.maxRequests,
			plan,
		})
	}
}
