import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import {
	computeDelayedExecuteWindow,
	syncFleetExecuteDays,
} from './fleet-execute-days.ts'

async function createDb(input?: {
	liveUserIds?: Array<string>
	days?: Array<{ day: string; eventCount: number }>
	rollups?: Array<{ userId: string; month: string; eventCount: number }>
}) {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsageRollupsTestSchema(db)
	await db
		.prepare(
			`CREATE TABLE users (
				stable_user_id TEXT PRIMARY KEY,
				deleting_at TEXT
			)`,
		)
		.run()
	for (const userId of input?.liveUserIds ?? []) {
		await db
			.prepare(
				`INSERT INTO users (stable_user_id, deleting_at) VALUES (?, NULL)`,
			)
			.bind(userId)
			.run()
	}
	for (const day of input?.days ?? []) {
		await db
			.prepare(
				`INSERT INTO fleet_execute_days (day, event_count, updated_at)
				VALUES (?, ?, '2026-08-01T00:00:00.000Z')`,
			)
			.bind(day.day, day.eventCount)
			.run()
	}
	for (const row of input?.rollups ?? []) {
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
	return db
}

function createEnv(db: D1Database) {
	return {
		USAGE_EVENTS: { writeDataPoint() {} },
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
	}
}

function stubFetchByQuery(
	handlers: Array<{ test: (query: string) => boolean; body: unknown }>,
) {
	const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
		const query = String(init?.body ?? '')
		const match = handlers.find((handler) => handler.test(query))
		return new Response(JSON.stringify(match?.body ?? { data: [] }), {
			status: 200,
		})
	})
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	})
}

function augustAndJulyBodies(input: { august?: unknown; july?: unknown }) {
	return stubFetchByQuery([
		{
			test: (query) => query.includes("toDateTime('2026-09-01 00:00:00')"),
			body: input.august ?? { data: [] },
		},
		{
			test: (query) => query.includes("toDateTime('2026-07-01 00:00:00')"),
			body: input.july ?? { data: [] },
		},
	])
}

async function listDays(db: D1Database) {
	const { results } = await db
		.prepare(`SELECT day, event_count FROM fleet_execute_days ORDER BY day`)
		.all<{ day: string; event_count: number }>()
	return results
}

test('syncFleetExecuteDays no-ops without Analytics Engine credentials', async () => {
	using fetchMock = stubFetchByQuery([])
	const db = await createDb()
	await expect(
		syncFleetExecuteDays({ APP_DB: db }, new Date('2026-08-24T20:00:00.000Z')),
	).resolves.toEqual({ skipped: true, reason: 'missing-analytics-config' })
	expect(fetchMock).not.toHaveBeenCalled()
	expect(await listDays(db)).toEqual([])
})

test('syncFleetExecuteDays upserts live execute days and ignores deleted users', async () => {
	using fetchMock = augustAndJulyBodies({
		august: {
			data: [
				{ user_id: 'user-live', day: '2026-08-23', event_count: 10 },
				{ user_id: 'user-live', day: '2026-08-24', event_count: 4 },
				{ user_id: 'user-gone', day: '2026-08-23', event_count: 99 },
			],
		},
		july: {
			data: [{ user_id: 'user-live', day: '2026-07-31', event_count: 7 }],
		},
	})
	const db = await createDb({ liveUserIds: ['user-live'] })
	await expect(
		syncFleetExecuteDays(createEnv(db), new Date('2026-08-24T20:00:00.000Z')),
	).resolves.toEqual({ skipped: false, upsertedDays: 3, deletedDays: 0 })
	expect(fetchMock).toHaveBeenCalledTimes(2)
	expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
		"blob2 = 'execute'",
	)
	expect(await listDays(db)).toEqual([
		{ day: '2026-07-31', event_count: 7 },
		{ day: '2026-08-23', event_count: 10 },
		{ day: '2026-08-24', event_count: 4 },
	])
})

test('syncFleetExecuteDays does not wipe a month when Analytics Engine returns nothing', async () => {
	using _fetchMock = augustAndJulyBodies({})
	const db = await createDb({
		liveUserIds: ['user-live'],
		days: [
			{ day: '2026-08-22', eventCount: 12 },
			{ day: '2026-07-30', eventCount: 3 },
		],
	})
	await expect(
		syncFleetExecuteDays(createEnv(db), new Date('2026-08-24T20:00:00.000Z')),
	).resolves.toEqual({ skipped: false, upsertedDays: 0, deletedDays: 0 })
	expect(await listDays(db)).toEqual([
		{ day: '2026-07-30', event_count: 3 },
		{ day: '2026-08-22', event_count: 12 },
	])
})

test('syncFleetExecuteDays deletes days absent from a non-empty month result', async () => {
	using _fetchMock = augustAndJulyBodies({
		august: {
			data: [{ user_id: 'user-live', day: '2026-08-23', event_count: 8 }],
		},
	})
	const db = await createDb({
		liveUserIds: ['user-live'],
		days: [
			{ day: '2026-08-22', eventCount: 12 },
			{ day: '2026-08-23', eventCount: 1 },
			{ day: '2026-07-30', eventCount: 3 },
		],
	})
	await expect(
		syncFleetExecuteDays(createEnv(db), new Date('2026-08-24T20:00:00.000Z')),
	).resolves.toEqual({ skipped: false, upsertedDays: 1, deletedDays: 1 })
	expect(await listDays(db)).toEqual([
		{ day: '2026-07-30', event_count: 3 },
		{ day: '2026-08-23', event_count: 8 },
	])
})

test('computeDelayedExecuteWindow sums older monthly rollups plus completed days', async () => {
	const db = await createDb({
		rollups: [
			{ userId: 'a', month: '2026-06', eventCount: 100 },
			{ userId: 'a', month: '2026-07', eventCount: 40 },
			{ userId: 'a', month: '2026-08', eventCount: 999 },
		],
		days: [
			{ day: '2026-07-31', eventCount: 5 },
			{ day: '2026-08-22', eventCount: 20 },
			{ day: '2026-08-23', eventCount: 30 },
			{ day: '2026-08-24', eventCount: 99 },
		],
	})
	expect(
		await computeDelayedExecuteWindow(db, new Date('2026-08-24T15:00:00.000Z')),
	).toEqual({
		status: 'ready',
		window: {
			start: 125,
			end: 155,
			updateAt: '2026-08-25T00:00:00.000Z',
		},
	})
	expect(
		await computeDelayedExecuteWindow(db, new Date('2026-08-25T00:00:00.000Z')),
	).toEqual({
		status: 'ready',
		window: {
			start: 155,
			end: 254,
			updateAt: '2026-08-26T00:00:00.000Z',
		},
	})
	expect(
		await computeDelayedExecuteWindow(db, new Date('2026-08-24T15:00:00.000Z')),
	).toEqual({
		status: 'ready',
		window: {
			start: 125,
			end: 155,
			updateAt: '2026-08-25T00:00:00.000Z',
		},
	})
})

test('computeDelayedExecuteWindow hides when the daily table is empty', async () => {
	const db = await createDb({
		rollups: [{ userId: 'a', month: '2026-07', eventCount: 40 }],
	})
	expect(
		await computeDelayedExecuteWindow(db, new Date('2026-08-24T15:00:00.000Z')),
	).toEqual({ status: 'empty' })
})

test('computeDelayedExecuteWindow reports failed when D1 throws instead of empty', async () => {
	const db = {
		prepare() {
			throw new Error('D1 unavailable')
		},
	} as unknown as D1Database
	expect(
		await computeDelayedExecuteWindow(db, new Date('2026-08-24T15:00:00.000Z')),
	).toEqual({ status: 'failed' })
})
