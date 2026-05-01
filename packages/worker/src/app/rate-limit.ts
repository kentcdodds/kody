type RateLimitConfig = {
	maxRequests: number
	windowSeconds: number
}

type RateLimitResult = {
	allowed: boolean
	retryAfterSeconds: number | null
}

/**
 * KV-backed sliding window rate limiter. Each key maps to a JSON
 * array of epoch-second timestamps representing recent requests.
 * Stale entries outside the window are pruned on every check.
 */
export async function checkRateLimit(
	kv: KVNamespace,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	const now = Math.floor(Date.now() / 1000)
	const windowStart = now - config.windowSeconds

	const stored = await kv.get(key, 'json')
	const timestamps: Array<number> = Array.isArray(stored)
		? (stored as Array<number>).filter((t) => t > windowStart)
		: []

	if (timestamps.length >= config.maxRequests) {
		const oldestInWindow = timestamps[0] ?? now
		const retryAfterSeconds = Math.max(
			1,
			oldestInWindow + config.windowSeconds - now,
		)
		return { allowed: false, retryAfterSeconds }
	}

	timestamps.push(now)
	await kv.put(key, JSON.stringify(timestamps), {
		expirationTtl: config.windowSeconds + 60,
	})

	return { allowed: true, retryAfterSeconds: null }
}

export const authRateLimitConfig: RateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 60,
}
