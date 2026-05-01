type RateLimitConfig = {
	maxRequests: number
	windowSeconds: number
}

type RateLimitResult = {
	allowed: boolean
	retryAfterSeconds: number | null
}

const initializedDbs = new WeakSet<D1Database>()

async function ensureRateLimitTable(db: D1Database) {
	if (initializedDbs.has(db)) return
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS _rate_limits (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL,
				ts INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON _rate_limits (key, ts)`,
		),
	])
	initializedDbs.add(db)
}

/**
 * D1-backed rate limiter. Counts recent rows first, then inserts
 * only when the request is allowed. Blocked requests do not write
 * rows, preventing attacker traffic from extending lockout windows
 * for legitimate users.
 *
 * D1 batch semantics run all statements in one transaction, and the
 * count-then-insert order means concurrent requests that land in the
 * same batch see a consistent snapshot.
 */
export async function checkRateLimit(
	db: D1Database,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	await ensureRateLimitTable(db)

	const now = Math.floor(Date.now() / 1000)
	const windowStart = now - config.windowSeconds

	const [, countResult] = await db.batch([
		db.prepare(`DELETE FROM _rate_limits WHERE ts <= ?`).bind(windowStart),
		db
			.prepare(
				`SELECT COUNT(*) as cnt FROM _rate_limits WHERE key = ? AND ts > ?`,
			)
			.bind(key, windowStart),
	])

	const row = countResult?.results?.[0] as { cnt: number } | undefined
	const count = row?.cnt ?? 0

	if (count >= config.maxRequests) {
		return {
			allowed: false,
			retryAfterSeconds: config.windowSeconds,
		}
	}

	await db
		.prepare(`INSERT INTO _rate_limits (key, ts) VALUES (?, ?)`)
		.bind(key, now)
		.run()

	return { allowed: true, retryAfterSeconds: null }
}

export const authRateLimitConfig: RateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 60,
}
