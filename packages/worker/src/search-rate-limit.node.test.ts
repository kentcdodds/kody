import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	consumeSearchRateLimit,
	isSearchRateLimitError,
	searchBurstRateLimitKey,
	searchDailyRateLimitKey,
	searchRateLimitByPlan,
	SearchRateLimitError,
} from './search-rate-limit.ts'

vi.mock('#worker/entitlements/service.ts', () => ({
	getUserPlan: vi.fn(async () => 'free'),
}))

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	return { sqlite, db }
}

test('searchRateLimitByPlan doubles burst while keeping daily DOW ceilings', () => {
	expect(searchRateLimitByPlan).toEqual({
		free: {
			burst: { maxRequests: 80, windowSeconds: 60 },
			daily: { maxRequests: 1_000, windowSeconds: 60 * 60 * 24 },
		},
		standard: {
			burst: { maxRequests: 160, windowSeconds: 60 },
			daily: { maxRequests: 5_000, windowSeconds: 60 * 60 * 24 },
		},
		pro: {
			burst: { maxRequests: 200, windowSeconds: 60 },
			daily: { maxRequests: 10_000, windowSeconds: 60 * 60 * 24 },
		},
		max: {
			burst: { maxRequests: 240, windowSeconds: 60 },
			daily: { maxRequests: 25_000, windowSeconds: 60 * 60 * 24 },
		},
	})
})

test('consumeSearchRateLimit no-ops without a userId', async () => {
	const { sqlite, db } = createDb()
	await consumeSearchRateLimit({
		db,
		userId: null,
		email: null,
	})
	expect(
		sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE name = '_rate_limits'`)
			.get(),
	).toBeUndefined()
})

test('consumeSearchRateLimit allows searches under the free burst ceiling', async () => {
	const { db } = createDb()
	const limit = searchRateLimitByPlan.free.burst.maxRequests
	for (let index = 0; index < limit; index++) {
		await consumeSearchRateLimit({
			db,
			userId: 'user-search-1',
			email: 'user@example.com',
		})
	}
})

test('consumeSearchRateLimit rejects over the free burst ceiling', async () => {
	const { db } = createDb()
	const limit = searchRateLimitByPlan.free.burst.maxRequests
	for (let index = 0; index < limit; index++) {
		await consumeSearchRateLimit({
			db,
			userId: 'user-search-2',
			email: 'user@example.com',
		})
	}
	const error = await consumeSearchRateLimit({
		db,
		userId: 'user-search-2',
		email: 'user@example.com',
	}).then(
		() => null,
		(cause: unknown) => cause,
	)
	expect(isSearchRateLimitError(error)).toBe(true)
	expect(error).toBeInstanceOf(SearchRateLimitError)
	if (!(error instanceof SearchRateLimitError)) {
		throw new Error('expected SearchRateLimitError')
	}
	expect(error.code).toBe('rate_limited')
	expect(error.window).toBe('burst')
	expect(error.limit).toBe(limit)
	expect(error.retryAfterSeconds).toBe(
		searchRateLimitByPlan.free.burst.windowSeconds,
	)
})

test('consumeSearchRateLimit rejects over the daily ceiling and refunds the burst slot', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-31T04:00:00.000Z'))
	const { sqlite, db } = createDb()
	const dailyLimit = searchRateLimitByPlan.free.daily.maxRequests
	const dailyKey = searchDailyRateLimitKey('user-search-3')
	const burstKey = searchBurstRateLimitKey('user-search-3')
	const now = Math.floor(Date.now() / 1000)

	await consumeSearchRateLimit({
		db,
		userId: 'user-search-3',
		email: 'user@example.com',
	})
	sqlite.prepare(`DELETE FROM _rate_limits WHERE key = ?`).run(burstKey)
	sqlite.prepare(`DELETE FROM _rate_limits WHERE key = ?`).run(dailyKey)
	const insert = sqlite.prepare(
		`INSERT INTO _rate_limits (key, ts) VALUES (?, ?)`,
	)
	for (let index = 0; index < dailyLimit; index++) {
		insert.run(dailyKey, now)
	}

	const error = await consumeSearchRateLimit({
		db,
		userId: 'user-search-3',
		email: 'user@example.com',
	}).then(
		() => null,
		(cause: unknown) => cause,
	)
	expect(isSearchRateLimitError(error)).toBe(true)
	expect(error).toBeInstanceOf(SearchRateLimitError)
	if (!(error instanceof SearchRateLimitError)) {
		throw new Error('expected SearchRateLimitError')
	}
	expect(error.window).toBe('day')
	expect(error.limit).toBe(dailyLimit)
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS n FROM _rate_limits WHERE key = ?`)
			.get(burstKey),
	).toEqual({ n: 0 })

	vi.useRealTimers()
})
