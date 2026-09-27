import { afterEach, expect, test, vi } from 'vitest'
import { toAdminMeasuredDurableObjectDuration } from '#universal/durable-object-duration.ts'
import {
	attributeDurableObjectActiveTime,
	buildDurableObjectOwnerMap,
	runDurableObjectDurationAttribution,
	type DurableObjectDurationAttributionEnv,
} from './durable-object-duration-attribution.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

function fakeNamespace(label: string) {
	return {
		idFromName: (name: string) => ({ toString: () => `${label}:${name}` }),
	}
}

function createEnv(input: {
	users?: Array<string>
	buckets?: Array<{ user_id: string; storage_id: string; kind: string }>
	apps?: Array<{ user_id: string; id: string }>
	credentials?: boolean
}) {
	const batches: Array<Array<{ sql: string; params: Array<unknown> }>> = []
	const db = {
		prepare(sql: string) {
			const statement = {
				sql,
				params: [] as Array<unknown>,
				bind(...params: Array<unknown>) {
					statement.params = params
					return statement
				},
				async all() {
					if (sql.includes('FROM users')) {
						return {
							results: (input.users ?? []).map((id) => ({
								stable_user_id: id,
							})),
						}
					}
					if (sql.includes('FROM user_storage_buckets')) {
						return { results: input.buckets ?? [] }
					}
					if (sql.includes('FROM saved_packages')) {
						return { results: input.apps ?? [] }
					}
					return { results: [] }
				},
			}
			return statement
		},
		async batch(statements: Array<{ sql: string; params: Array<unknown> }>) {
			batches.push(statements.map(({ sql, params }) => ({ sql, params })))
			return []
		},
	}
	const env = {
		APP_DB: db,
		MCP_CLIENT_HUB: fakeNamespace('hub'),
		STORAGE_RUNNER: fakeNamespace('storage'),
		RUN_LOG: fakeNamespace('runlog'),
		USER_METER: fakeNamespace('meter'),
		MAILBOX: fakeNamespace('mailbox'),
		REPO_SESSION_INDEX: fakeNamespace('index'),
		STRIPE_PLAN_REFRESH: fakeNamespace('stripe'),
		REPO_SESSION: fakeNamespace('session'),
		PACKAGE_REALTIME_SESSION: fakeNamespace('realtime'),
		...(input.credentials === false
			? {}
			: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token' }),
	} as unknown as DurableObjectDurationAttributionEnv
	return { env, batches }
}

test('owner map covers user-named, bucket, repo-session, and realtime objects', async () => {
	const { env } = createEnv({
		users: ['user-a'],
		buckets: [
			{ user_id: 'user-a', storage_id: 'package:p1', kind: 'package' },
			{
				user_id: 'user-a',
				storage_id: 'repo-session:rs-1',
				kind: 'repo_session',
			},
			{ user_id: 'user-a', storage_id: 'malformed', kind: 'repo_session' },
		],
		apps: [{ user_id: 'user-a', id: 'pkg-1' }],
	})
	const owners = await buildDurableObjectOwnerMap(env)
	expect(owners.get('hub:user-a')).toEqual({
		userId: 'user-a',
		doClass: 'McpClientHub',
	})
	expect(owners.get('runlog:user-a')?.doClass).toBe('RunLog')
	expect(owners.get('storage:["user-a","package:p1"]')?.doClass).toBe(
		'StorageRunner',
	)
	expect(owners.get('session:rs-1')).toEqual({
		userId: 'user-a',
		doClass: 'RepoSession',
	})
	expect(owners.get('realtime:["user-a","pkg-1"]')?.doClass).toBe(
		'PackageRealtimeSession',
	)
	expect(owners.has('session:malformed')).toBe(false)
	expect(owners.has('session:repo-session:rs-1')).toBe(false)
})

test('active time converts microseconds and keeps unmapped objects unattributed', () => {
	const owners = new Map([
		['hub:a', { userId: 'a', doClass: 'McpClientHub' }],
		['session:1', { userId: 'a', doClass: 'RepoSession' }],
		['session:2', { userId: 'a', doClass: 'RepoSession' }],
	])
	const result = attributeDurableObjectActiveTime({
		owners,
		groups: [
			{ dimensions: { objectId: 'hub:a' }, sum: { activeTime: 3_600_000_000 } },
			{ dimensions: { objectId: 'session:1' }, sum: { activeTime: 1_500 } },
			{ dimensions: { objectId: 'session:2' }, sum: { activeTime: 2_500 } },
			{
				dimensions: { objectId: 'mcp-session' },
				sum: { activeTime: 9_000_000 },
			},
		],
	})
	expect(result.rows).toEqual([
		{
			userId: 'a',
			doClass: 'McpClientHub',
			activeMs: 3_600_000,
			objectCount: 1,
		},
		{ userId: 'a', doClass: 'RepoSession', activeMs: 5, objectCount: 2 },
	])
	expect(result.totalActiveMs).toBe(3_609_005)
	expect(result.attributedActiveMs).toBe(3_600_005)
	expect(result.objectCount).toBe(4)
	expect(result.attributedObjectCount).toBe(3)
})

test('the fleet total replaces a truncated per-object sum as the denominator', () => {
	const result = attributeDurableObjectActiveTime({
		owners: new Map([['hub:a', { userId: 'a', doClass: 'McpClientHub' }]]),
		groups: [
			{ dimensions: { objectId: 'hub:a' }, sum: { activeTime: 4_000_000 } },
		],
		fleetActiveTimeUs: 10_000_000,
	})
	expect(result.totalActiveMs).toBe(10_000)
	expect(result.attributedActiveMs).toBe(4_000)
})

test('the lane rewrites days with analytics atomically and skips lagging empty days', async () => {
	const { env, batches } = createEnv({ users: ['user-a'] })
	const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
		const { variables } = JSON.parse(String(init.body)) as {
			variables: { day: string; accountTag: string }
		}
		expect(variables.accountTag).toBe('acct')
		return new Response(
			JSON.stringify({
				data: {
					viewer: {
						accounts: [
							{
								durableObjectsPeriodicGroups:
									variables.day === '2026-09-26'
										? [
												{
													dimensions: { objectId: 'hub:user-a' },
													sum: { activeTime: 2_000_000 },
												},
											]
										: [],
							},
						],
					},
				},
			}),
		)
	})
	vi.stubGlobal('fetch', fetchStub)
	const result = await runDurableObjectDurationAttribution({
		env,
		now: new Date('2026-09-27T03:20:00.000Z'),
	})
	expect(result).toMatchObject({
		status: 'completed',
		days: [
			{
				day: '2026-09-26',
				totalActiveMs: 2_000,
				attributedActiveMs: 2_000,
				skipped: false,
			},
			{ day: '2026-09-27', skipped: true },
		],
	})
	expect(fetchStub.mock.calls[0]?.[0]).toBe(
		'https://api.cloudflare.com/client/v4/graphql',
	)
	expect(batches).toHaveLength(1)
	expect(batches[0]?.[0]).toMatchObject({
		sql: 'DELETE FROM durable_object_duration_daily WHERE day = ?',
		params: ['2026-09-26'],
	})
	expect(batches[0]?.[1]?.params.slice(0, 5)).toEqual([
		'user-a',
		'McpClientHub',
		'2026-09-26',
		2_000,
		1,
	])
})

test('the lane skips without credentials and surfaces analytics errors', async () => {
	await expect(
		runDurableObjectDurationAttribution({
			env: createEnv({ credentials: false }).env,
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'missing_credentials' })

	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ errors: [{ message: 'not authorized' }] }),
				),
		),
	)
	await expect(
		runDurableObjectDurationAttribution({ env: createEnv({}).env }),
	).rejects.toThrow('not authorized')
})

test('a response without the account fails instead of zeroing the day', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(JSON.stringify({ data: { viewer: { accounts: [] } } })),
		),
	)
	const { env, batches } = createEnv({ users: ['user-a'] })
	await expect(runDurableObjectDurationAttribution({ env })).rejects.toThrow(
		'no account',
	)
	expect(batches).toHaveLength(0)
})

test('admin measured duration is gross GB-s at list, sorted by class', () => {
	const measured = toAdminMeasuredDurableObjectDuration([
		{ doClass: 'RunLog', activeMs: 1_000_000, lastDay: '2026-09-25' },
		{ doClass: 'McpClientHub', activeMs: 7_812_500_000, lastDay: '2026-09-26' },
	])
	expect(measured.byClass.map((row) => row.doClass)).toEqual([
		'McpClientHub',
		'RunLog',
	])
	expect(measured.gbSeconds).toBeCloseTo(1_000_128, 0)
	expect(measured.estimatedUsd).toBeCloseTo(12.5, 1)
	expect(measured.lastDay).toBe('2026-09-26')
	expect(toAdminMeasuredDurableObjectDuration([])).toMatchObject({
		activeMs: 0,
		lastDay: null,
		byClass: [],
	})
})
