type RateLimitConfig = {
	maxRequests: number
	windowSeconds: number
}

type RateLimitResult = {
	allowed: boolean
	retryAfterSeconds: number | null
}

/**
 * D1-backed rate limiter using a single atomic SQL transaction.
 * Each call inserts a new row and counts recent rows in one
 * statement batch, avoiding the read-then-write race that
 * KV-backed approaches suffer from under concurrency.
 *
 * The table is auto-created on first use if it doesn't exist.
 */
export async function checkRateLimit(
	db: D1Database,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	const now = Math.floor(Date.now() / 1000)
	const windowStart = now - config.windowSeconds

	const batch = await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS _rate_limits (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					key TEXT NOT NULL,
					ts INTEGER NOT NULL
				)`,
		),
		db.prepare(`DELETE FROM _rate_limits WHERE ts <= ?`).bind(windowStart),
		db
			.prepare(`INSERT INTO _rate_limits (key, ts) VALUES (?, ?)`)
			.bind(key, now),
		db
			.prepare(
				`SELECT COUNT(*) as cnt FROM _rate_limits WHERE key = ? AND ts > ?`,
			)
			.bind(key, windowStart),
	])

	const countResult = batch[3]
	const row = countResult?.results?.[0] as { cnt: number } | undefined
	const count = row?.cnt ?? 0

	if (count > config.maxRequests) {
		return {
			allowed: false,
			retryAfterSeconds: config.windowSeconds,
		}
	}

	return { allowed: true, retryAfterSeconds: null }
}

export const authRateLimitConfig: RateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 60,
}
