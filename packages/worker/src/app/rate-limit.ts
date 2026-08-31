type RateLimitConfig = {
	maxRequests: number
	windowSeconds: number
}

type RateLimitResult = {
	allowed: boolean
	retryAfterSeconds: number | null
}

type AuthRateLimitEnv = {
	APP_DB: D1Database
	AUTH_RATE_LIMITER?: RateLimit
}

type SentryTunnelRateLimitEnv = {
	APP_DB: D1Database
	SENTRY_TUNNEL_RATE_LIMITER?: RateLimit
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
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_rate_limits_ts ON _rate_limits (ts)`,
		),
	])
	initializedDbs.add(db)
}

/**
 * D1-backed rate limiter. Uses a conditional INSERT inside a single
 * batch transaction so the count check and the row write are atomic
 * — no TOCTOU gap for concurrent requests to exploit. Blocked
 * requests do not insert rows.
 */
export async function checkRateLimit(
	db: D1Database,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	await ensureRateLimitTable(db)

	const now = Math.floor(Date.now() / 1000)
	const windowStart = now - config.windowSeconds

	const results = await db.batch([
		db
			.prepare(`DELETE FROM _rate_limits WHERE key = ? AND ts <= ?`)
			.bind(key, windowStart),
		db
			.prepare(
				`INSERT INTO _rate_limits (key, ts)
				SELECT ?, ?
				WHERE (SELECT COUNT(*) FROM _rate_limits WHERE key = ? AND ts > ?) < ?`,
			)
			.bind(key, now, key, windowStart, config.maxRequests),
	])

	const insertMeta = results[1]?.meta
	const inserted = (insertMeta?.changes ?? 0) > 0

	if (!inserted) {
		return {
			allowed: false,
			retryAfterSeconds: config.windowSeconds,
		}
	}

	return { allowed: true, retryAfterSeconds: null }
}

/**
 * Refund the most recent slot consumed for `key`. Use when the
 * rate-limited operation itself failed, so transient downstream errors
 * do not eat into the caller's allowance.
 */
export async function releaseRateLimit(db: D1Database, key: string) {
	await ensureRateLimitTable(db)
	await db
		.prepare(
			`DELETE FROM _rate_limits
			 WHERE id = (
				SELECT id FROM _rate_limits WHERE key = ? ORDER BY id DESC LIMIT 1
			 )`,
		)
		.bind(key)
		.run()
}

export const authRateLimitConfig: RateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 60,
}

/**
 * Guessing a 6-digit TOTP code only works with many attempts, so the second
 * factor gets a far tighter per-account budget than the per-IP auth ingress
 * limit (which a distributed attacker can spread across addresses).
 */
export const twoFactorVerifyRateLimitConfig: RateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 60 * 15,
}

/**
 * A browser tab with session replay enabled posts an envelope every few
 * seconds, so the ceiling has to clear steady replay traffic while still
 * capping a scripted flood from a single address.
 */
export const sentryTunnelRateLimitConfig: RateLimitConfig = {
	maxRequests: 120,
	windowSeconds: 60,
}

/**
 * Uses Cloudflare's per-location rate-limit binding when deployed, keeping a
 * D1 fallback for local development, tests, and self-hosted configs.
 */
async function checkBoundRateLimit(
	limiter: RateLimit | undefined,
	db: D1Database,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	if (!limiter) {
		return checkRateLimit(db, key, config)
	}
	const result = await limiter.limit({ key })
	return result.success
		? { allowed: true, retryAfterSeconds: null }
		: { allowed: false, retryAfterSeconds: config.windowSeconds }
}

export async function checkAuthRateLimit(
	env: AuthRateLimitEnv,
	key: string,
): Promise<RateLimitResult> {
	return checkBoundRateLimit(
		env.AUTH_RATE_LIMITER,
		env.APP_DB,
		key,
		authRateLimitConfig,
	)
}

export async function checkSentryTunnelRateLimit(
	env: SentryTunnelRateLimitEnv,
	key: string,
): Promise<RateLimitResult> {
	return checkBoundRateLimit(
		env.SENTRY_TUNNEL_RATE_LIMITER,
		env.APP_DB,
		key,
		sentryTunnelRateLimitConfig,
	)
}
