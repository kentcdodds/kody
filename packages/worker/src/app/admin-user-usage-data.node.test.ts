import { expect, test } from 'vitest'
import {
	maxPlanEmailLimits,
	planLimits,
	unknownStoredPlanWarningTag,
} from '#worker/entitlements/plans.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type AdminUsageRollup } from './loader-data.ts'
import { loadAdminUserUsageData } from './admin-user-usage-data.ts'

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

type CounterRow = {
	user_id: string
	resource: string
	day: string
	count: number
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
	dailyCounters?: Array<CounterRow>
	resourceCounts?: Record<string, ResourceCount>
}) {
	const users = input.users.map((user) => ({ ...user }))
	const usageRollups = input.usageRollups?.map((row) => ({ ...row })) ?? []
	const dailyCounters = input.dailyCounters?.map((row) => ({ ...row })) ?? []
	const resourceCounts = input.resourceCounts ?? {}

	function countForQuery(normalizedQuery: string, userId: string) {
		const counts = resourceCounts[userId] ?? {}
		if (normalizedQuery.includes('from saved_packages')) {
			return counts.saved_packages ?? 0
		}
		if (normalizedQuery.includes('from jobs')) {
			return counts.scheduled_jobs ?? 0
		}
		if (normalizedQuery.includes('from package_runtime_runs')) {
			return counts.package_services ?? 0
		}
		if (normalizedQuery.includes('from repo_sessions')) {
			return counts.repo_sessions ?? 0
		}
		if (normalizedQuery.includes('from email_messages')) {
			return counts.stored_email_messages ?? 0
		}
		if (normalizedQuery.includes('from secret_entries')) {
			return counts.secrets ?? 0
		}
		if (normalizedQuery.includes('from workflow_runs')) {
			return counts.concurrent_workflows ?? 0
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
							'select id, username, email, plan, stripe_plan, stable_user_id from users where id = ?',
						)
					) {
						return (users.find((user) => user.id === Number(params[0])) ??
							null) as T | null
					}
					if (normalizedQuery.includes('from entitlement_daily_counters')) {
						const row = dailyCounters.find(
							(counter) =>
								counter.user_id === params[0] &&
								counter.resource === params[1] &&
								counter.day === params[2],
						)
						return (row ? { count: row.count } : null) as T | null
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
			{ APP_DB: emptyDb } as Env,
			42,
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
		{ APP_DB: db } as Env,
		1,
		new Date('2026-07-05T12:00:00.000Z'),
	)

	expect(data?.currentMonth).toBe('2026-07')
	expect(data?.today).toBe('2026-07-05')
	expect(data?.userId).toBe(1)
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
		dailyCounters: [
			{
				user_id: usageUserId,
				resource: 'email_sends_per_day',
				day: '2026-07-05',
				count: 170,
			},
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

	const data = await loadAdminUserUsageData(
		{ APP_DB: db } as Env,
		2,
		new Date('2026-07-05T12:00:00.000Z'),
	)

	expect(data?.userId).toBe(2)
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

test('loadAdminUserUsageData shows max email caps for unknown stored plans', async () => {
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
		dailyCounters: [
			{
				user_id: usageUserId,
				resource: 'email_receives_per_day',
				day: '2026-07-05',
				count: 190,
			},
		],
		resourceCounts: {
			[usageUserId]: { stored_email_messages: 12 },
		},
	})

	silenceExpectedConsoleWarns([unknownStoredPlanWarningTag])
	const data = await loadAdminUserUsageData(
		{ APP_DB: db } as Env,
		1,
		new Date('2026-07-05T12:00:00.000Z'),
	)

	expect(data?.plan).toBe('max')
	expect(consoleWarn).toHaveBeenCalledWith(unknownStoredPlanWarningTag)
	const consumption = new Map(
		(data?.entitlementConsumption ?? []).map((entry) => [
			entry.resource,
			entry,
		]),
	)
	// Coerced max uses finite ordinary ceilings...
	expect(consumption.get('saved_packages')?.limit).toBe(
		planLimits.max.maxSavedPackages,
	)
	// ...and email resources use the max plan's email caps.
	expect(consumption.get('email_sends_per_day')?.limit).toBe(
		maxPlanEmailLimits.email_sends_per_day,
	)
	expect(consumption.get('email_receives_per_day')).toMatchObject({
		current: 190,
		limit: 200,
		overEightyPercent: true,
	})
	expect(consumption.get('stored_email_messages')).toMatchObject({
		current: 12,
		limit: 2000,
		overEightyPercent: false,
	})
	expect(data?.warnings.map((warning) => warning.resource)).toEqual([
		'email_receives_per_day',
	])
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
	const env = { APP_DB: countingDb, BUNDLE_ARTIFACTS_KV: kv } as Env
	const now = new Date('2026-07-05T12:00:00.000Z')

	const first = await loadAdminUserUsageData(env, 1, now)
	expect(getEventCount(first?.currentMonthUsage, 'execute')).toBe(7)
	const queriesAfterFirstLoad = rollupQueryCount
	expect(queriesAfterFirstLoad).toBeGreaterThan(0)
	expect(store.size).toBeGreaterThan(0)
	for (const key of store.keys()) {
		expect(key.startsWith('derived-cache:v1:usage-rollups:')).toBe(true)
	}

	const second = await loadAdminUserUsageData(env, 1, now)
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
		{ APP_DB: db } as Env,
		1,
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

function getEventCount(
	usage: Array<AdminUsageRollup> | undefined,
	metric: AdminUsageRollup['metric'],
) {
	return usage?.find((row) => row.metric === metric)?.eventCount ?? 0
}
