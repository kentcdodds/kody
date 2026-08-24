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
		store,
	} as unknown as KVNamespace & { store: Map<string, string> }
}

async function createEnv(input?: {
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
	const kv = createMemoryKv(
		input?.window
			? { [publicCodeRunsKvKey]: JSON.stringify(input.window) }
			: undefined,
	)
	return { APP_DB: db, BUNDLE_ARTIFACTS_KV: kv }
}

test('refreshPublicCodeRunsWindow initializes a still pair, unsticks when the fleet grows, and holds a live window for 24h', async () => {
	const env = await createEnv({
		rows: [
			{ userId: 'a', month: '2026-07', eventCount: 40 },
			{ userId: 'b', month: '2026-08', eventCount: 60 },
		],
	})
	const start = new Date('2026-08-21T00:00:00.000Z')
	await expect(
		refreshPublicCodeRunsWindow({ env, now: start }),
	).resolves.toEqual({ status: 'initialized' })

	const still = await loadPublicCodeRunsWindow(env, start)
	expect(still).toEqual({
		previous: 100,
		current: 100,
		windowStart: '2026-08-21T00:00:00.000Z',
		windowEnd: '2026-08-22T00:00:00.000Z',
	})

	await expect(
		refreshPublicCodeRunsWindow({
			env,
			now: new Date('2026-08-21T12:00:00.000Z'),
		}),
	).resolves.toEqual({ status: 'held' })
	expect(await loadPublicCodeRunsWindow(env, start)).toEqual(still)

	await env.APP_DB.prepare(
		`UPDATE usage_rollups SET event_count = 90 WHERE user_id = 'b'`,
	).run()
	await expect(
		refreshPublicCodeRunsWindow({
			env,
			now: new Date('2026-08-21T12:01:00.000Z'),
		}),
	).resolves.toEqual({ status: 'rotated' })
	const live = await loadPublicCodeRunsWindow(
		env,
		new Date('2026-08-21T12:01:00.000Z'),
	)
	expect(live).toEqual({
		previous: 100,
		current: 130,
		windowStart: '2026-08-21T12:01:00.000Z',
		windowEnd: '2026-08-22T12:01:00.000Z',
	})

	await env.APP_DB.prepare(
		`UPDATE usage_rollups SET event_count = 110 WHERE user_id = 'b'`,
	).run()
	await expect(
		refreshPublicCodeRunsWindow({
			env,
			now: new Date('2026-08-21T18:00:00.000Z'),
		}),
	).resolves.toEqual({ status: 'held' })
	expect(
		await loadPublicCodeRunsWindow(env, new Date('2026-08-21T18:00:00.000Z')),
	).toEqual(live)

	await expect(
		refreshPublicCodeRunsWindow({
			env,
			now: new Date('2026-08-22T12:01:00.000Z'),
		}),
	).resolves.toEqual({ status: 'rotated' })
	expect(
		await loadPublicCodeRunsWindow(env, new Date('2026-08-22T12:01:00.000Z')),
	).toEqual({
		previous: 130,
		current: 150,
		windowStart: '2026-08-22T12:01:00.000Z',
		windowEnd: '2026-08-23T12:01:00.000Z',
	})

	await env.APP_DB.prepare(
		`UPDATE usage_rollups SET event_count = 10 WHERE user_id = 'b'`,
	).run()
	await expect(
		refreshPublicCodeRunsWindow({
			env,
			now: new Date('2026-08-23T12:01:00.000Z'),
		}),
	).resolves.toEqual({ status: 'rotated' })
	expect(
		await loadPublicCodeRunsWindow(env, new Date('2026-08-23T12:01:00.000Z')),
	).toEqual({
		previous: 150,
		current: 150,
		windowStart: '2026-08-23T12:01:00.000Z',
		windowEnd: '2026-08-24T12:01:00.000Z',
	})
})

test('public code-runs load falls back to D1 and hides when KV fails or there are no runs', async () => {
	const fallback = await createEnv({
		rows: [{ userId: 'a', month: '2026-08', eventCount: 12 }],
	})
	fallback.BUNDLE_ARTIFACTS_KV.store.clear()
	expect(
		await loadPublicCodeRunsWindow(
			fallback,
			new Date('2026-08-22T12:00:00.000Z'),
		),
	).toMatchObject({ previous: 12, current: 12 })

	const kvDown = await createEnv({
		rows: [{ userId: 'a', month: '2026-08', eventCount: 12 }],
	})
	kvDown.BUNDLE_ARTIFACTS_KV.get = async () => {
		throw new Error('kv down')
	}
	await expect(
		refreshPublicCodeRunsWindow({
			env: kvDown,
			now: new Date('2026-08-22T00:00:00.000Z'),
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'kv_read_failed' })
	expect(kvDown.BUNDLE_ARTIFACTS_KV.store.size).toBe(0)
	expect(await loadPublicCodeRunsWindow(kvDown)).toBeNull()

	const empty = await createEnv()
	await expect(
		refreshPublicCodeRunsWindow({
			env: empty,
			now: new Date('2026-08-22T00:00:00.000Z'),
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'no_runs' })
	expect(await loadPublicCodeRunsWindow(empty)).toBeNull()
})

test('public code-runs load continues an expired window without writing KV', async () => {
	const env = await createEnv({
		rows: [{ userId: 'a', month: '2026-08', eventCount: 200 }],
		window: {
			previous: 100,
			current: 150,
			windowStart: '2026-08-21T00:00:00.000Z',
			windowEnd: '2026-08-22T00:00:00.000Z',
		},
	})
	const loaded = await loadPublicCodeRunsWindow(
		env,
		new Date('2026-08-22T02:00:00.000Z'),
	)
	expect(loaded).toEqual({
		previous: 150,
		current: 200,
		windowStart: '2026-08-22T00:00:00.000Z',
		windowEnd: '2026-08-23T00:00:00.000Z',
	})
	expect(env.BUNDLE_ARTIFACTS_KV.store.get(publicCodeRunsKvKey)).toBe(
		JSON.stringify({
			previous: 100,
			current: 150,
			windowStart: '2026-08-21T00:00:00.000Z',
			windowEnd: '2026-08-22T00:00:00.000Z',
		}),
	)
})
