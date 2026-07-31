import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	authRateLimitConfig,
	checkAuthRateLimit,
	checkRateLimit,
} from './rate-limit.ts'

test('D1 rate limiting cleans up only the key being checked', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-31T04:00:00.000Z'))
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)

	await checkRateLimit(db, 'auth:ip:current', authRateLimitConfig)
	sqlite
		.prepare(`INSERT INTO _rate_limits (key, ts) VALUES (?, ?)`)
		.run('webhook:user:other', 1)
	sqlite
		.prepare(`INSERT INTO _rate_limits (key, ts) VALUES (?, ?)`)
		.run('auth:ip:current', 1)

	await expect(
		checkRateLimit(db, 'auth:ip:current', authRateLimitConfig),
	).resolves.toEqual({ allowed: true, retryAfterSeconds: null })
	expect(
		sqlite
			.prepare(`SELECT key, ts FROM _rate_limits ORDER BY id`)
			.all()
			.filter((row) => row.ts === 1),
	).toEqual([{ key: 'webhook:user:other', ts: 1 }])

	vi.useRealTimers()
})

test('auth binding preserves the ten requests per sixty seconds contract', async () => {
	let requests = 0
	const limit = vi.fn(async ({ key }: RateLimitOptions) => {
		expect(key).toBe('auth:ip:198.51.100.42')
		requests++
		return { success: requests <= authRateLimitConfig.maxRequests }
	})
	const env = {
		AUTH_RATE_LIMITER: { limit },
		APP_DB: null as unknown as D1Database,
	}

	for (let index = 0; index < authRateLimitConfig.maxRequests; index++) {
		await expect(
			checkAuthRateLimit(env, 'auth:ip:198.51.100.42'),
		).resolves.toEqual({ allowed: true, retryAfterSeconds: null })
	}
	await expect(
		checkAuthRateLimit(env, 'auth:ip:198.51.100.42'),
	).resolves.toEqual({
		allowed: false,
		retryAfterSeconds: authRateLimitConfig.windowSeconds,
	})
	expect(limit).toHaveBeenCalledTimes(11)
})
