import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	type AdminUsageLoaderData,
	type AdminUsageRollup,
} from './loader-data.ts'
import { loadAdminUsageData } from './admin-usage-data.ts'

type UserRow = {
	id: number
	username: string
	email: string
	plan: string | null
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

function createAdminUsageTestDb(input: {
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
					if (normalizedQuery.includes('select count(*) as total from users')) {
						return { total: users.length } as T
					}
					if (
						normalizedQuery.includes(
							'select id, username, email, plan from users where id = ?',
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
						normalizedQuery.includes(
							'select id, username, email, plan from users order by id asc limit ? offset ?',
						)
					) {
						const pageSize = Number(params[0])
						const offset = Number(params[1])
						return {
							results: users
								.sort((left, right) => left.id - right.id)
								.slice(offset, offset + pageSize) as Array<T>,
						}
					}
					if (
						normalizedQuery.includes('from usage_rollups') &&
						normalizedQuery.includes('where user_id in')
					) {
						const month = String(params.at(-1))
						const userIds = params.slice(0, -1).map(String)
						return {
							results: usageRollups.filter(
								(row) => userIds.includes(row.user_id) && row.month === month,
							) as Array<T>,
						}
					}
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

test('loadAdminUsageData returns zeroed usage for empty rollups', async () => {
	const email = 'empty-usage@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	const db = createAdminUsageTestDb({
		users: [
			{
				id: 1,
				username: 'empty',
				email,
				plan: 'personal',
			},
		],
		resourceCounts: {
			[usageUserId]: {},
		},
	})

	const data = await loadAdminUsageData(
		{ APP_DB: db } as Env,
		'https://kody.local/admin/usage.json',
		new Date('2026-07-05T12:00:00.000Z'),
	)

	expect(data.currentMonth).toBe('2026-07')
	expect(data.today).toBe('2026-07-05')
	expect(data.users).toHaveLength(1)
	expect(
		data.users[0]?.currentMonthUsage.every((row) => row.eventCount === 0),
	).toBe(true)
	expect(data.users[0]?.todayCounters).toEqual([
		{ resource: 'email_sends_per_day', label: 'email sends per day', count: 0 },
		{
			resource: 'email_receives_per_day',
			label: 'email receives per day',
			count: 0,
		},
	])
	expect(data.selectedUser?.monthUsage).toEqual([
		{
			month: '2026-07',
			usage: expect.arrayContaining([
				expect.objectContaining({ metric: 'execute', eventCount: 0 }),
			]),
		},
	])
})

test('loadAdminUsageData aggregates multiple users and warns above eighty percent of plan limits', async () => {
	const adminEmail = 'admin-usage@example.com'
	const memberEmail = 'member-usage@example.com'
	const adminUsageUserId = await createStableUserIdFromEmail(adminEmail)
	const memberUsageUserId = await createStableUserIdFromEmail(memberEmail)
	const db = createAdminUsageTestDb({
		users: [
			{
				id: 1,
				username: 'admin',
				email: adminEmail,
				plan: 'pro',
			},
			{
				id: 2,
				username: 'member',
				email: memberEmail,
				plan: 'personal',
			},
		],
		usageRollups: [
			usageRow({
				user_id: adminUsageUserId,
				metric: 'execute',
				month: '2026-07',
				event_count: 5,
			}),
			usageRow({
				user_id: memberUsageUserId,
				metric: 'job_run',
				month: '2026-07',
				event_count: 4,
			}),
			usageRow({
				user_id: memberUsageUserId,
				metric: 'job_run',
				month: '2026-06',
				event_count: 40,
			}),
		],
		dailyCounters: [
			{
				user_id: memberUsageUserId,
				resource: 'email_sends_per_day',
				day: '2026-07-05',
				count: 17,
			},
		],
		resourceCounts: {
			[adminUsageUserId]: { saved_packages: 3 },
			[memberUsageUserId]: {
				saved_packages: 18,
				scheduled_jobs: 8,
				package_services: 1,
				repo_sessions: 2,
				secrets: 7,
			},
		},
	})

	const data = await loadAdminUsageData(
		{ APP_DB: db } as Env,
		'https://kody.local/admin/usage.json?userId=2',
		new Date('2026-07-05T12:00:00.000Z'),
	)

	expect(data.users).toHaveLength(2)
	expect(getEventCount(data.users[0], 'execute')).toBe(5)
	expect(getEventCount(data.users[1], 'job_run')).toBe(4)
	expect(data.users[1]?.todayCounters[0]?.count).toBe(17)
	expect(data.selectedUser?.id).toBe(2)
	expect(
		data.selectedUser?.warnings.map((warning) => warning.resource),
	).toEqual(['saved_packages', 'email_sends_per_day'])
})

test('loadAdminUsageData shows email fallback limits for plan-less users', async () => {
	const email = 'null-plan-email@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	const db = createAdminUsageTestDb({
		users: [
			{
				id: 1,
				username: 'nullplan',
				email,
				plan: null,
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

	const data = await loadAdminUsageData(
		{ APP_DB: db } as Env,
		'https://kody.local/admin/usage.json?userId=1',
		new Date('2026-07-05T12:00:00.000Z'),
	)

	const consumption = new Map(
		(data.selectedUser?.entitlementConsumption ?? []).map((entry) => [
			entry.resource,
			entry,
		]),
	)
	// Plan-less users stay unlimited for ordinary resources...
	expect(consumption.get('saved_packages')?.limit).toBeNull()
	expect(consumption.get('email_sends_per_day')?.limit).toBeNull()
	// ...but the inbound email resources show the deployment fallbacks.
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
	expect(
		data.selectedUser?.warnings.map((warning) => warning.resource),
	).toEqual(['email_receives_per_day'])
})

test('loadAdminUsageData keeps current-month and month-over-month rollups on UTC month boundaries', async () => {
	const email = 'month-boundary@example.com'
	const usageUserId = await createStableUserIdFromEmail(email)
	const db = createAdminUsageTestDb({
		users: [
			{
				id: 1,
				username: 'boundary',
				email,
				plan: null,
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

	const data = await loadAdminUsageData(
		{ APP_DB: db } as Env,
		'https://kody.local/admin/usage.json',
		new Date('2026-07-01T00:00:00.000Z'),
	)

	expect(getEventCount(data.users[0], 'execute')).toBe(2)
	expect(data.selectedUser?.monthUsage.map((month) => month.month)).toEqual([
		'2026-07',
		'2026-06',
	])
	expect(
		getEventCountFromUsage(
			data.selectedUser?.monthUsage[0]?.usage ?? [],
			'execute',
		),
	).toBe(2)
	expect(
		getEventCountFromUsage(
			data.selectedUser?.monthUsage[1]?.usage ?? [],
			'execute',
		),
	).toBe(12)
})

function getEventCount(
	user: AdminUsageLoaderData['users'][number] | undefined,
	metric: AdminUsageRollup['metric'],
) {
	return getEventCountFromUsage(user?.currentMonthUsage ?? [], metric)
}

function getEventCountFromUsage(
	usage: Array<AdminUsageRollup>,
	metric: AdminUsageRollup['metric'],
) {
	return usage.find((row) => row.metric === metric)?.eventCount ?? 0
}
