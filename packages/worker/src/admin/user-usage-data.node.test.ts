import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type AdminUsageRollup } from '#app/loader-data.ts'
import { loadAdminUserUsageData } from './user-usage-data.ts'

const resourceCountsByDb = new WeakMap<
	D1Database,
	Record<string, ResourceCount>
>()

function withUserMeter(env: { APP_DB: D1Database } & Record<string, unknown>) {
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	const resourceCounts = resourceCountsByDb.get(env.APP_DB) ?? {}
	const mailbox = {
		idFromName(userId: string) {
			return { userId } as unknown as DurableObjectId
		},
		get(id: DurableObjectId) {
			const userId = (id as unknown as { userId: string }).userId
			return {
				async countMessages() {
					return {
						total: resourceCounts[userId]?.stored_email_messages ?? 0,
					}
				},
			}
		},
	} as unknown as DurableObjectNamespace
	return {
		...env,
		...meter.env,
		...runLog.env,
		MAILBOX: mailbox,
		meter,
		runLog,
	}
}

type UserRow = {
	id: number
	username: string
	email: string
	plan: string
	stripe_plan?: string | null
	stable_user_id: string
}

type UsageRollupRow = {
	user_id: string
	metric: string
	month: string
	event_count: number
	error_count: number
	total_duration_ms: number
	total_cpu_ms: number
	total_bytes: number
}

type ResourceCount = Partial<
	Record<
		| 'saved_packages'
		| 'scheduled_jobs'
		| 'package_services'
		| 'repo_sessions'
		| 'stored_email_messages'
		| 'secrets'
		| 'concurrent_workflows',
		number
	>
>

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

function createAdminUserUsageTestDb(input: {
	users: Array<UserRow>
	usageRollups?: Array<UsageRollupRow>
	resourceCounts?: Record<string, ResourceCount>
}) {
	const users = input.users.map((user) => ({ ...user }))
	const usageRollups = input.usageRollups?.map((row) => ({ ...row })) ?? []
	const resourceCounts = input.resourceCounts ?? {}

	function countForQuery(normalizedQuery: string, userId: string) {
		const counts = resourceCounts[userId] ?? {}
		if (normalizedQuery.includes('from saved_packages')) {
			return counts.saved_packages ?? 0
		}
		if (normalizedQuery.includes('from jobs')) {
			return counts.scheduled_jobs ?? 0
		}
		if (normalizedQuery.includes('from package_service_states')) {
			return counts.package_services ?? 0
		}
		if (normalizedQuery.includes('from repo_sessions')) {
			return counts.repo_sessions ?? 0
		}
		if (normalizedQuery.includes('from secret_entries')) {
			return counts.secrets ?? 0
		}
		return null
	}

	const db = {
		prepare(query: string) {
			const normalizedQuery = normalizeQuery(query)
			const createStatement = (params: Array<unknown>) => ({
				async first<T>() {
					if (
						normalizedQuery.includes(
							'select id, username, email, plan, stripe_plan, stable_user_id from users where stable_user_id = ?',
						)
					) {
						return (users.find((user) => user.stable_user_id === params[0]) ??
							null) as T | null
					}
					if (
						normalizedQuery.includes(
							'select 1 as present from users where stable_user_id = ?',
						)
					) {
						const exists = users.some(
							(user) => user.stable_user_id === params[0],
						)
						return (exists ? { present: 1 } : null) as T | null
					}
					const count = countForQuery(normalizedQuery, String(params[0]))
					if (count !== null) return { count } as T
					throw new Error(`Unsupported first query: ${query}`)
				},
				async all<T>() {
					if (
						normalizedQuery.includes('from usage_rollups') &&
						normalizedQuery.includes('where user_id = ?')
					) {
						return {
							results: usageRollups
								.filter((row) => row.user_id === params[0])
								.sort(
									(left, right) =>
										right.month.localeCompare(left.month) ||
										left.metric.localeCompare(right.metric),
								) as Array<T>,
						}
					}
					return { results: [] as Array<T> }
				},
				async run() {
					throw new Error(`Unsupported run query: ${query}`)
				},
			})
			return {
				...createStatement([]),
				bind(...params: Array<unknown>) {
					return createStatement(params)
				},
			}
		},
	} as unknown as D1Database

	resourceCountsByDb.set(db, resourceCounts)
	return db
}

function usageRow(
	input: Partial<UsageRollupRow> &
		Pick<UsageRollupRow, 'user_id' | 'metric' | 'month'>,
): UsageRollupRow {
	return {
		event_count: 0,
		error_count: 0,
		total_duration_ms: 0,
		total_cpu_ms: 0,
		total_bytes: 0,
		...input,
	}
}

test('loadAdminUserUsageData returns null for unknown users and zeroed usage for empty rollups', async () => {
	const emptyDb = createAdminUserUsageTestDb({ users: [] })
	expect(
		await loadAdminUserUsageData(
			withUserMeter({ APP_DB: emptyDb }) as Env,
			'missing-stable-user',
			new Date('2026-07-05T12:00:00.000Z'),
		),
	).toBeNull()

	const email = 'empty-usage@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	const db = createAdminUserUsageTestDb({
		users: [
			{
				id: 1,
				username: 'empty',
				email,
				plan: 'pro',
				stable_user_id: usageUserId,
			},
		],
		resourceCounts: {
			[usageUserId]: {},
		},
	})

	const data = await loadAdminUserUsageData(
		withUserMeter({ APP_DB: db }) as Env,
		usageUserId,
		new Date('2026-07-05T12:00:00.000Z'),
	)

	expect(data?.currentMonth).toBe('2026-07')
	expect(data?.today).toBe('2026-07-05')
	expect(data?.stableUserId).toBe(usageUserId)
	expect(data?.currentMonthUsage.every((row) => row.eventCount === 0)).toBe(
		true,
	)
	expect(data?.monthUsage).toEqual([
		{
			month: '2026-07',
			usage: expect.arrayContaining([
				expect.objectContaining({ metric: 'execute', eventCount: 0 }),
			]),
		},
	])
	expect(data?.warnings).toEqual([])
})

test('loadAdminUserUsageData warns above eighty percent of plan limits', async () => {
	const email = 'member-usage@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	const db = createAdminUserUsageTestDb({
		users: [
			{
				id: 2,
				username: 'member',
				email,
				plan: 'pro',
				stable_user_id: usageUserId,
			},
		],
		usageRollups: [
			usageRow({
				user_id: usageUserId,
				metric: 'job_run',
				month: '2026-07',
				event_count: 4,
			}),
			usageRow({
				user_id: usageUserId,
				metric: 'job_run',
				month: '2026-06',
				event_count: 40,
			}),
		],
		resourceCounts: {
			[usageUserId]: {
				saved_packages: 85,
				scheduled_jobs: 8,
				package_services: 1,
				repo_sessions: 2,
				secrets: 7,
			},
		},
	})

	const env = withUserMeter({ APP_DB: db })
	await env.meter.seed({
		userId: usageUserId,
		resource: 'email_sends_per_day',
		day: '2026-07-05',
		count: 170,
	})
	const data = await loadAdminUserUsageData(
		env as Env,
		usageUserId,
		new Date('2026-07-05T12:00:00.000Z'),
	)

	expect(data?.stableUserId).toBe(usageUserId)
	expect(getEventCount(data?.currentMonthUsage, 'job_run')).toBe(4)
	expect(data?.monthUsage.map((month) => month.month)).toEqual([
		'2026-07',
		'2026-06',
	])
	expect(data?.warnings.map((warning) => warning.resource)).toEqual([
		'saved_packages',
		'email_sends_per_day',
	])
})

test('loadAdminUserUsageData rejects an invalid stored plan', async () => {
	const email = 'unknown-plan-email@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	const db = createAdminUserUsageTestDb({
		users: [
			{
				id: 1,
				username: 'unknownplan',
				email,
				plan: 'enterprise-2099',
				stable_user_id: usageUserId,
			},
		],
		resourceCounts: {
			[usageUserId]: { stored_email_messages: 12 },
		},
	})

	await expect(
		loadAdminUserUsageData(
			withUserMeter({ APP_DB: db }) as Env,
			usageUserId,
			new Date('2026-07-05T12:00:00.000Z'),
		),
	).rejects.toThrow('Stored plan is not a registered plan name.')
})

function createFakeKv() {
	const store = new Map<string, string>()
	const kv = {
		async get(key: string, _type: 'json') {
			const raw = store.get(key)
			return raw === undefined ? null : JSON.parse(raw)
		},
		async put(key: string, value: string, _options?: unknown) {
			store.set(key, value)
		},
		async delete(key: string) {
			store.delete(key)
		},
	} as unknown as KVNamespace
	return { kv, store }
}

test('loadAdminUserUsageData caches rollup reads in KV and serves repeat loads from cache', async () => {
	const email = 'cached-usage@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	let rollupQueryCount = 0
	const db = createAdminUserUsageTestDb({
		users: [
			{
				id: 1,
				username: 'cached',
				email,
				plan: 'max',
				stable_user_id: usageUserId,
			},
		],
		usageRollups: [
			usageRow({
				user_id: usageUserId,
				metric: 'execute',
				month: '2026-07',
				event_count: 7,
			}),
		],
		resourceCounts: { [usageUserId]: {} },
	})
	const countingDb = new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					if (normalizeQuery(query).includes('from usage_rollups')) {
						rollupQueryCount += 1
					}
					return target.prepare(query)
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})
	const { kv, store } = createFakeKv()
	const env = withUserMeter({
		APP_DB: countingDb,
		BUNDLE_ARTIFACTS_KV: kv,
	}) as Env
	const now = new Date('2026-07-05T12:00:00.000Z')

	const first = await loadAdminUserUsageData(env, usageUserId, now)
	expect(getEventCount(first?.currentMonthUsage, 'execute')).toBe(7)
	const queriesAfterFirstLoad = rollupQueryCount
	expect(queriesAfterFirstLoad).toBeGreaterThan(0)
	expect(store.size).toBeGreaterThan(0)
	for (const key of store.keys()) {
		expect(key.startsWith('derived-cache:v1:usage-rollups:')).toBe(true)
	}

	const second = await loadAdminUserUsageData(env, usageUserId, now)
	expect(getEventCount(second?.currentMonthUsage, 'execute')).toBe(7)
	expect(second?.monthUsage[0]?.month).toBe('2026-07')
	// The repeat load is served from KV: no additional rollup queries.
	expect(rollupQueryCount).toBe(queriesAfterFirstLoad)
})

test('loadAdminUserUsageData keeps current-month and month-over-month rollups on UTC month boundaries', async () => {
	const email = 'month-boundary@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	const db = createAdminUserUsageTestDb({
		users: [
			{
				id: 1,
				username: 'boundary',
				email,
				plan: 'max',
				stable_user_id: usageUserId,
			},
		],
		usageRollups: [
			usageRow({
				user_id: usageUserId,
				metric: 'execute',
				month: '2026-06',
				event_count: 12,
			}),
			usageRow({
				user_id: usageUserId,
				metric: 'execute',
				month: '2026-07',
				event_count: 2,
			}),
		],
		resourceCounts: {
			[usageUserId]: {},
		},
	})

	const data = await loadAdminUserUsageData(
		withUserMeter({ APP_DB: db }) as Env,
		usageUserId,
		new Date('2026-07-01T00:00:00.000Z'),
	)

	expect(getEventCount(data?.currentMonthUsage, 'execute')).toBe(2)
	expect(data?.monthUsage.map((month) => month.month)).toEqual([
		'2026-07',
		'2026-06',
	])
	expect(getEventCount(data?.monthUsage[0]?.usage, 'execute')).toBe(2)
	expect(getEventCount(data?.monthUsage[1]?.usage, 'execute')).toBe(12)
})

test('loadAdminUserUsageData reads daily counts from UserMeter (seeded then warm)', async () => {
	const now = new Date('2026-07-05T12:00:00.000Z')
	const day = utcDayKey(now)

	const bootstrapEmail = 'bootstrap-drilldown@example.com'
	const bootstrapUserId = await createStableUserIdFromEmail(bootstrapEmail)
	const bootstrapEnv = withUserMeter({
		APP_DB: createAdminUserUsageTestDb({
			users: [
				{
					id: 3,
					username: 'bootstrap',
					email: bootstrapEmail,
					plan: 'pro',
					stable_user_id: bootstrapUserId,
				},
			],
			resourceCounts: {
				[bootstrapUserId]: { secrets: 3 },
			},
		}),
	})
	await bootstrapEnv.meter.seed({
		userId: bootstrapUserId,
		resource: 'email_receives_per_day',
		day,
		count: 55,
	})
	await bootstrapEnv.meter.seed({
		userId: bootstrapUserId,
		resource: 'outbound_fetches_per_day',
		day,
		count: 66,
	})
	const bootstrapped = await loadAdminUserUsageData(
		bootstrapEnv as Env,
		bootstrapUserId,
		now,
	)
	expect(
		bootstrapped?.entitlementConsumption.find(
			(row) => row.resource === 'email_receives_per_day',
		)?.current,
	).toBe(55)
	expect(
		bootstrapped?.entitlementConsumption.find(
			(row) => row.resource === 'outbound_fetches_per_day',
		)?.current,
	).toBe(66)
	expect(
		bootstrapped?.entitlementConsumption.find(
			(row) => row.resource === 'secrets',
		)?.current,
	).toBe(3)

	const meterEmail = 'meter-drilldown@example.com'
	const meterUserId = await createStableUserIdFromEmail(meterEmail)
	const warmEnv = withUserMeter({
		APP_DB: createAdminUserUsageTestDb({
			users: [
				{
					id: 4,
					username: 'meter',
					email: meterEmail,
					plan: 'pro',
					stable_user_id: meterUserId,
				},
			],
			resourceCounts: {
				[meterUserId]: {
					saved_packages: 6,
					stored_email_messages: 9,
				},
			},
		}),
	})
	warmEnv.runLog.setActiveWorkflowCount(meterUserId, 2)
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'email_sends_per_day',
		day,
		count: 111,
	})
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'email_receives_per_day',
		day,
		count: 222,
	})
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'execute_calls_per_day',
		day,
		count: 333,
	})
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'outbound_fetches_per_day',
		day,
		count: 444,
	})
	const warm = await loadAdminUserUsageData(warmEnv as Env, meterUserId, now)
	expect(
		warm?.entitlementConsumption.find(
			(row) => row.resource === 'email_sends_per_day',
		)?.current,
	).toBe(111)
	expect(
		warm?.entitlementConsumption.find(
			(row) => row.resource === 'email_receives_per_day',
		)?.current,
	).toBe(222)
	expect(
		warm?.entitlementConsumption.find(
			(row) => row.resource === 'execute_calls_per_day',
		)?.current,
	).toBe(333)
	expect(
		warm?.entitlementConsumption.find(
			(row) => row.resource === 'outbound_fetches_per_day',
		)?.current,
	).toBe(444)
	expect(
		warm?.entitlementConsumption.find(
			(row) => row.resource === 'saved_packages',
		)?.current,
	).toBe(6)
	expect(
		warm?.entitlementConsumption.find(
			(row) => row.resource === 'stored_email_messages',
		)?.current,
	).toBe(9)
	expect(
		warm?.entitlementConsumption.find(
			(row) => row.resource === 'concurrent_workflows',
		)?.current,
	).toBe(2)
})

function getEventCount(
	usage: Array<AdminUsageRollup> | undefined,
	metric: AdminUsageRollup['metric'],
) {
	return usage?.find((row) => row.metric === metric)?.eventCount ?? 0
}
