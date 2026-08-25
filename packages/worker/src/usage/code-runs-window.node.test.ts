import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import {
	loadPublicCodeRunsWindow,
	publicCodeRunsKvKey,
	refreshPublicCodeRunsWindow,
} from './code-runs-window.ts'

function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async delete(key: string) {
			store.delete(key)
		},
		store,
	} as unknown as KVNamespace & { store: Map<string, string> }
}

async function createEnv(input?: {
	days?: Array<{ day: string; eventCount: number }>
	rows?: Array<{ userId: string; month: string; eventCount: number }>
	window?: unknown
}) {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsageRollupsTestSchema(db)
	for (const row of input?.rows ?? []) {
		await db
			.prepare(
				`INSERT INTO usage_rollups (
					user_id, metric, month, event_count, error_count,
					total_duration_ms, total_cpu_ms, total_bytes
				) VALUES (?, 'execute', ?, ?, 0, 0, 0, 0)`,
			)
			.bind(row.userId, row.month, row.eventCount)
			.run()
	}
	for (const day of input?.days ?? []) {
		await db
			.prepare(
				`INSERT INTO fleet_execute_days (day, event_count, updated_at)
				VALUES (?, ?, '2026-08-24T12:00:00.000Z')`,
			)
			.bind(day.day, day.eventCount)
			.run()
	}
	const kv = createMemoryKv(
		input?.window
			? { [publicCodeRunsKvKey]: JSON.stringify(input.window) }
			: undefined,
	)
	return { APP_DB: db, BUNDLE_ARTIFACTS_KV: kv }
}

const midday = new Date('2026-08-24T15:00:00.000Z')
const expectedWindow = {
	start: 1030,
	end: 1060,
	updateAt: '2026-08-25T00:00:00.000Z',
}

async function seededEnv(window?: unknown) {
	return createEnv({
		rows: [{ userId: 'a', month: '2026-07', eventCount: 1000 }],
		days: [
			{ day: '2026-08-21', eventCount: 10 },
			{ day: '2026-08-22', eventCount: 20 },
			{ day: '2026-08-23', eventCount: 30 },
			{ day: '2026-08-24', eventCount: 99 },
		],
		window,
	})
}

test('load and refresh derive start/end from completed days and ignore today', async () => {
	const env = await seededEnv()
	await expect(
		refreshPublicCodeRunsWindow({ env, now: midday }),
	).resolves.toEqual({ status: 'initialized' })
	expect(await loadPublicCodeRunsWindow(env, midday)).toEqual(expectedWindow)
	expect(env.BUNDLE_ARTIFACTS_KV.store.get(publicCodeRunsKvKey)).toBe(
		JSON.stringify(expectedWindow),
	)

	await expect(
		refreshPublicCodeRunsWindow({ env, now: midday }),
	).resolves.toEqual({ status: 'held' })
	expect(await loadPublicCodeRunsWindow(env, midday)).toEqual(expectedWindow)
})

test('load recomputes after updateAt and fills KV without latching a high-water mark', async () => {
	const stale = {
		start: 257940,
		end: 257940,
		updateAt: '2026-08-24T00:00:00.000Z',
	}
	const env = await seededEnv(stale)
	const loaded = await loadPublicCodeRunsWindow(env, midday)
	expect(loaded).toEqual(expectedWindow)
	expect(env.BUNDLE_ARTIFACTS_KV.store.get(publicCodeRunsKvKey)).toBe(
		JSON.stringify(expectedWindow),
	)
})

test('load returns a valid cached triple without writing and ignores v1 JSON', async () => {
	const cached = {
		start: 10,
		end: 20,
		updateAt: '2026-08-25T00:00:00.000Z',
	}
	const cachedEnv = await seededEnv(cached)
	expect(await loadPublicCodeRunsWindow(cachedEnv, midday)).toEqual(cached)
	expect(cachedEnv.BUNDLE_ARTIFACTS_KV.store.get(publicCodeRunsKvKey)).toBe(
		JSON.stringify(cached),
	)

	const v1 = await createEnv({
		days: [{ day: '2026-08-23', eventCount: 12 }],
		window: {
			previous: 12,
			current: 12,
			windowStart: '2026-08-24T00:00:00.000Z',
			windowEnd: '2026-08-25T00:00:00.000Z',
		},
	})
	expect(await loadPublicCodeRunsWindow(v1, midday)).toEqual({
		start: 0,
		end: 12,
		updateAt: '2026-08-25T00:00:00.000Z',
	})
})

test('public code-runs load hides when KV fails or there are no completed days', async () => {
	const kvDown = await seededEnv()
	kvDown.BUNDLE_ARTIFACTS_KV.get = async () => {
		throw new Error('kv down')
	}
	await expect(
		refreshPublicCodeRunsWindow({ env: kvDown, now: midday }),
	).resolves.toEqual({ status: 'skipped', reason: 'kv_read_failed' })
	expect(kvDown.BUNDLE_ARTIFACTS_KV.store.size).toBe(0)
	expect(await loadPublicCodeRunsWindow(kvDown, midday)).toBeNull()

	const empty = await createEnv()
	await expect(
		refreshPublicCodeRunsWindow({ env: empty, now: midday }),
	).resolves.toEqual({ status: 'skipped', reason: 'no_runs' })
	expect(await loadPublicCodeRunsWindow(empty, midday)).toBeNull()

	const todayOnly = await createEnv({
		days: [{ day: '2026-08-24', eventCount: 99 }],
	})
	expect(await loadPublicCodeRunsWindow(todayOnly, midday)).toBeNull()
})

test('refresh replaces yesterday’s triple at the next UTC midnight without waiting for cron', async () => {
	const env = await seededEnv({
		start: 1030,
		end: 1060,
		updateAt: '2026-08-25T00:00:00.000Z',
	})
	const midnight = new Date('2026-08-25T00:00:00.000Z')
	await expect(
		refreshPublicCodeRunsWindow({ env, now: midnight }),
	).resolves.toEqual({ status: 'rotated' })
	expect(await loadPublicCodeRunsWindow(env, midnight)).toEqual({
		start: 1060,
		end: 1159,
		updateAt: '2026-08-26T00:00:00.000Z',
	})
})

test('a cached regressing triple is served until updateAt', async () => {
	const regression = {
		start: 200,
		end: 150,
		updateAt: '2026-08-25T00:00:00.000Z',
	}
	const env = await seededEnv(regression)
	expect(await loadPublicCodeRunsWindow(env, midday)).toEqual(regression)
	expect(env.BUNDLE_ARTIFACTS_KV.store.get(publicCodeRunsKvKey)).toBe(
		JSON.stringify(regression),
	)
})

test('a D1 query failure keeps the cached window instead of treating it as empty', async () => {
	const stale = {
		start: 90_000,
		end: 100_000,
		updateAt: '2026-08-24T00:00:00.000Z',
	}
	const env = await seededEnv(stale)
	env.APP_DB = {
		prepare() {
			throw new Error('D1 unavailable')
		},
	} as unknown as D1Database
	await expect(
		refreshPublicCodeRunsWindow({ env, now: midday }),
	).resolves.toEqual({
		status: 'skipped',
		reason: 'query_failed',
	})
	expect(env.BUNDLE_ARTIFACTS_KV.store.get(publicCodeRunsKvKey)).toBe(
		JSON.stringify(stale),
	)
	expect(await loadPublicCodeRunsWindow(env, midday)).toEqual(stale)
})
