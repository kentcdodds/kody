import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { type RunLogAdminInsightsSnapshot } from '#worker/run-records/admin-insights-snapshot.ts'
import {
	adminInsightsRunLogConcurrency,
	buildAuthDays,
	buildEmailDays,
	buildEmailDeliveryDays,
	buildHeatmapCells,
	buildSignupWeeks,
	buildUsageMonths,
	foldRunLogSnapshots,
	hoursFromVerifiedToActivation,
	listUtcDayKeys,
	listUtcMonthKeys,
	listUtcWeekStarts,
	loadAdminInsightsData,
	medianOf,
	utcWeekStart,
} from './admin-insights-data.ts'

const now = new Date('2026-07-08T12:00:00.000Z')

const runLogMocks = vi.hoisted(() => ({
	getAdminInsightsSnapshot:
		vi.fn<
			(input: {
				env: Env
				userId: string
			}) => Promise<RunLogAdminInsightsSnapshot>
		>(),
	inFlight: 0,
	maxInFlight: 0,
}))

const fleetUsageMocks = vi.hoisted(() => ({
	loadFleetUsageInsights: vi.fn(async () => ({
		topRuntimeDurationConsumers: [],
		topEventCountConsumers: [],
		topDurationConsumersByMetric: [],
		entitlementPressure: [],
	})),
}))

vi.mock('#worker/admin/fleet-usage-insights.ts', () => ({
	loadFleetUsageInsights: fleetUsageMocks.loadFleetUsageInsights,
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getAdminInsightsSnapshot: (input: { env: Env; userId: string }) =>
		runLogMocks.getAdminInsightsSnapshot(input),
}))

test('admin insights date helpers bucket, zero-fill, and fold correctly', () => {
	// 2026-07-08 is a Wednesday; 2026-07-06 is the Monday before.
	expect(utcWeekStart(new Date('2026-07-08T12:00:00.000Z'))).toBe('2026-07-06')
	expect(utcWeekStart(new Date('2026-07-06T00:00:00.000Z'))).toBe('2026-07-06')
	// Sunday belongs to the week that started the previous Monday.
	expect(utcWeekStart(new Date('2026-07-05T23:59:59.000Z'))).toBe('2026-06-29')

	const weeks = listUtcWeekStarts(now, 3)
	expect(weeks).toEqual(['2026-06-22', '2026-06-29', '2026-07-06'])
	const days = listUtcDayKeys(now, 3)
	expect(days).toEqual(['2026-07-06', '2026-07-07', '2026-07-08'])
	expect(listUtcMonthKeys(now, 3)).toEqual(['2026-05', '2026-06', '2026-07'])

	expect(
		buildSignupWeeks({
			dayRows: [
				{ day: '2026-06-23', n: 2 },
				{ day: '2026-06-29', n: 1 },
				{ day: '2026-07-04', n: 3 },
				{ day: '2026-07-08', n: 5 },
			],
			usersBeforeWindow: 10,
			now,
			weeks: 3,
		}),
	).toEqual([
		{ weekStart: '2026-06-22', signups: 2, cumulativeUsers: 12 },
		{ weekStart: '2026-06-29', signups: 4, cumulativeUsers: 16 },
		{ weekStart: '2026-07-06', signups: 5, cumulativeUsers: 21 },
	])

	const usageMonths = buildUsageMonths(
		[
			{ month: '2026-06', metric: 'execute', events: 7, errors: 1 },
			{ month: '2026-06', metric: 'job_run', events: 3, errors: 0 },
			{ month: '2026-07', metric: 'not_a_metric', events: 99, errors: 9 },
		],
		now,
		2,
	)
	expect(usageMonths.map((month) => month.month)).toEqual([
		'2026-06',
		'2026-07',
	])
	expect(usageMonths[0]?.events.execute).toBe(7)
	expect(usageMonths[0]?.events.job_run).toBe(3)
	expect(usageMonths[0]?.errorCount).toBe(1)
	expect(usageMonths[1]?.errorCount).toBe(0)
	expect(
		Object.values(usageMonths[1]?.events ?? {}).every((n) => n === 0),
	).toBe(true)

	const emailDays = buildEmailDays(
		[
			{ day: '2026-07-07', resource: 'email_sends_per_day', n: 4 },
			{ day: '2026-07-07', resource: 'email_receives_per_day', n: 6 },
		],
		now,
		2,
	)
	expect(emailDays).toEqual([
		{ day: '2026-07-07', sends: 4, receives: 6 },
		{ day: '2026-07-08', sends: 0, receives: 0 },
	])

	const emailDeliveryDays = buildEmailDeliveryDays(
		[
			{ day: '2026-07-07', event_type: 'delivered', n: 4 },
			{ day: '2026-07-07', event_type: 'bounced', n: 2 },
			{ day: '2026-07-08', event_type: 'complained', n: 1 },
			{ day: '2026-07-08', event_type: 'not-an-outcome', n: 9 },
		],
		now,
		2,
	)
	expect(emailDeliveryDays).toEqual([
		{
			day: '2026-07-07',
			delivered: 4,
			deferred: 0,
			bounced: 2,
			failed: 0,
			rejected: 0,
			complained: 0,
		},
		{
			day: '2026-07-08',
			delivered: 0,
			deferred: 0,
			bounced: 0,
			failed: 0,
			rejected: 0,
			complained: 1,
		},
	])

	const authDays = buildAuthDays(
		[
			{ day: '2026-07-08', result: 'success', n: 9 },
			{ day: '2026-07-08', result: 'failure', n: 2 },
			{ day: '2026-07-08', result: 'rate_limited', n: 1 },
		],
		now,
		2,
	)
	expect(authDays[1]).toEqual({
		day: '2026-07-08',
		success: 9,
		failure: 2,
		rateLimited: 1,
	})

	// 2026-07-01 and 2026-07-08 are both Wednesdays (weekday 3).
	expect(
		buildHeatmapCells([
			{ day: '2026-07-01', hour: '09', n: 2 },
			{ day: '2026-07-08', hour: '09', n: 3 },
			{ day: '2026-07-05', hour: '23', n: 1 },
			{ day: '2026-07-05', hour: 'xx', n: 5 },
		]),
	).toEqual([
		{ weekday: 0, hour: 23, count: 1 },
		{ weekday: 3, hour: 9, count: 5 },
	])
})

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

const defaultInsightsUsers = [
	{
		stable_user_id: 'user-a',
		email_verified_at: '2026-07-01T00:00:00.000Z',
	},
	{
		stable_user_id: 'user-b',
		email_verified_at: '2026-07-02T00:00:00.000Z',
	},
]

function emptySnapshot(): RunLogAdminInsightsSnapshot {
	return {
		workflowStatusCounts: [],
		activationMilestones: [],
		jobRunCounts: { success: 0, error: 0 },
	}
}

function createInsightsTestDb(
	overrides: {
		insightsUsers?: Array<{
			stable_user_id: string
			email_verified_at: string | null
		}>
	} = {},
) {
	const seenQueries: Array<string> = []
	const db = {
		prepare(query: string) {
			seenQueries.push(query)
			const normalizedQuery = normalizeQuery(query)
			const createStatement = (params: Array<unknown>) => ({
				async first<T>() {
					if (normalizedQuery.includes('sum(enabled) as enabled')) {
						return {
							total: 4,
							enabled: 3,
						} as T
					}
					if (normalizedQuery.includes('from users where created_at < ?')) {
						return { n: 6 } as T
					}
					if (
						normalizedQuery.includes(
							'count(*) as n from users where email_verified_at',
						)
					) {
						return { n: 5 } as T
					}
					if (normalizedQuery.includes('count(*) as n from users')) {
						return { n: 8 } as T
					}
					if (normalizedQuery.includes('from saved_packages')) {
						return { n: 11 } as T
					}
					if (normalizedQuery.includes('from mcp_memories')) {
						return { n: 13 } as T
					}
					if (normalizedQuery.includes('from email_messages')) {
						return { n: 15 } as T
					}
					if (normalizedQuery.includes('from secret_entries')) {
						return { n: 7 } as T
					}
					if (normalizedQuery.includes('from community_listings')) {
						return { n: 2 } as T
					}
					if (normalizedQuery.includes('from passkeys')) {
						return { n: 3 } as T
					}
					if (normalizedQuery.includes('from oauth_connections')) {
						return { n: 4 } as T
					}
					if (normalizedQuery.includes('from mcp_agent_sessions')) {
						return { n: 4 } as T
					}
					if (normalizedQuery.includes('from community_forks')) {
						return { n: 3 } as T
					}
					throw new Error(`Unsupported first query: ${query}`)
				},
				async all<T>() {
					if (
						normalizedQuery.includes(
							'select stable_user_id, email_verified_at',
						) &&
						normalizedQuery.includes('deleting_at is null')
					) {
						return {
							results: (overrides.insightsUsers ??
								defaultInsightsUsers) as Array<T>,
						}
					}
					if (
						normalizedQuery.includes('from users') &&
						normalizedQuery.includes('group by day')
					) {
						return { results: [{ day: '2026-07-07', n: 2 }] as Array<T> }
					}
					if (normalizedQuery.includes('from community_forks')) {
						return {
							results: [
								{ actor: 'human', n: 2 },
								{ actor: 'agent', n: 1 },
								{ actor: 'unknown', n: 4 },
							] as Array<T>,
						}
					}
					if (normalizedQuery.includes('from usage_rollups')) {
						expect(params[0]).toBe('2025-08')
						return {
							results: [
								{ month: '2026-07', metric: 'execute', events: 12, errors: 1 },
							] as Array<T>,
						}
					}
					if (normalizedQuery.includes('from email_delivery_events')) {
						return {
							results: [
								{ day: '2026-07-08', event_type: 'delivered', n: 5 },
								{ day: '2026-07-08', event_type: 'bounced', n: 1 },
							] as Array<T>,
						}
					}
					if (normalizedQuery.includes("coalesce(plan, 'none')")) {
						return {
							results: [
								{ plan: 'pro', n: 2 },
								{ plan: 'none', n: 6 },
							] as Array<T>,
						}
					}
					if (
						normalizedQuery.includes('from audit_events') &&
						normalizedQuery.includes('result')
					) {
						return {
							results: [
								{ day: '2026-07-08', result: 'success', n: 4 },
							] as Array<T>,
						}
					}
					if (
						normalizedQuery.includes('from audit_events') &&
						normalizedQuery.includes('group by category')
					) {
						return { results: [{ category: 'auth', n: 4 }] as Array<T> }
					}
					if (normalizedQuery.includes('substr(timestamp, 12, 2)')) {
						return {
							results: [{ day: '2026-07-08', hour: '09', n: 4 }] as Array<T>,
						}
					}
					throw new Error(`Unsupported all query: ${query}`)
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
		seenQueries,
	} as unknown as D1Database & { seenQueries: Array<string> }
	return db
}

function stubSnapshotsByUser(
	byUser: Record<string, RunLogAdminInsightsSnapshot | Error>,
) {
	runLogMocks.inFlight = 0
	runLogMocks.maxInFlight = 0
	runLogMocks.getAdminInsightsSnapshot.mockImplementation(
		async (input: { userId: string }) => {
			runLogMocks.inFlight += 1
			runLogMocks.maxInFlight = Math.max(
				runLogMocks.maxInFlight,
				runLogMocks.inFlight,
			)
			await Promise.resolve()
			runLogMocks.inFlight -= 1
			const result = byUser[input.userId]
			if (result instanceof Error) throw result
			if (!result) throw new Error(`Unexpected snapshot user ${input.userId}`)
			return result
		},
	)
}

test('loadAdminInsightsData assembles the dashboard payload from D1 plus RunLog snapshots', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleWarn.mockClear()
	stubSnapshotsByUser({
		'user-a': {
			workflowStatusCounts: [
				{ status: 'complete', count: 5 },
				{ status: 'errored', count: 1 },
			],
			jobRunCounts: { success: 12, error: 2 },
			activationMilestones: [
				{
					milestone: 'package_run_succeeded',
					reachedAt: '2026-07-02T12:00:00.000Z',
					packageId: 'pkg-a',
				},
				{
					milestone: 'package_activated',
					reachedAt: '2026-07-02T12:00:00.000Z',
					packageId: 'pkg-a',
				},
			],
		},
		'user-b': {
			workflowStatusCounts: [{ status: 'complete', count: 3 }],
			jobRunCounts: { success: 8, error: 0 },
			activationMilestones: [
				{
					milestone: 'package_run_succeeded',
					reachedAt: '2026-07-03T00:00:00.000Z',
					packageId: 'pkg-b',
				},
			],
		},
	})
	const db = createInsightsTestDb()
	const data = await loadAdminInsightsData(
		{
			APP_DB: db,
			AUDIT_DB: db,
			EMAIL_EVENTS: {} as AnalyticsEngineDataset,
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as Env,
		now,
	)

	expect(data.ok).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-insights-email-quota-aggregate-unavailable',
		{ reason: 'entitlement-daily-counters-retired-local-dev' },
	)
	expect(consoleWarn).not.toHaveBeenCalledWith(
		'admin-insights-email-quota-aggregate-unavailable',
		{ reason: 'missing-email-events-binding' },
	)
	expect(data.totals).toEqual({
		users: 8,
		verifiedUsers: 5,
		savedPackages: 11,
		scheduledJobs: 4,
		enabledJobs: 3,
		workflowRuns: 9,
		activeMemories: 13,
		storedEmailMessages: null,
		secrets: 7,
		activeCommunityListings: 2,
		passkeys: 3,
		oauthConnections: 4,
	})
	expect(data.signupsByWeek).toHaveLength(12)
	expect(data.signupsByWeek.at(-1)).toEqual({
		weekStart: '2026-07-06',
		signups: 2,
		cumulativeUsers: 8,
	})
	expect(data.usageByMonth).toHaveLength(12)
	expect(data.usageByMonth.at(-1)?.events.execute).toBe(12)
	expect(data.emailByDay).toHaveLength(28)
	expect(data.emailByDay.at(-1)).toEqual({
		day: '2026-07-08',
		sends: 0,
		receives: 0,
	})
	expect(data.emailDeliveryByDay).toHaveLength(28)
	expect(data.emailDeliveryByDay.at(-1)).toEqual({
		day: '2026-07-08',
		delivered: 0,
		deferred: 0,
		bounced: 0,
		failed: 0,
		rejected: 0,
		complained: 0,
	})
	expect(data.authByDay.at(-1)?.success).toBe(4)
	expect(data.authByCategory).toEqual([{ category: 'auth', count: 4 }])
	expect(data.authHeatmap).toEqual([{ weekday: 3, hour: 9, count: 4 }])
	expect(data.workflowStatuses).toEqual([
		{ status: 'complete', count: 8 },
		{ status: 'errored', count: 1 },
	])
	expect(data.jobHealth).toEqual({
		totalJobs: 4,
		enabledJobs: 3,
		successRuns: 20,
		errorRuns: 2,
	})
	const jobStatsQuery = db.seenQueries.find((query) =>
		normalizeQuery(query).includes('from jobs'),
	)
	expect(normalizeQuery(jobStatsQuery ?? '')).toBe(
		'select count(*) as total, sum(enabled) as enabled from jobs',
	)
	expect(data.activation.steps).toEqual([
		{ step: 'signed_up', users: 8 },
		{ step: 'email_verified', users: 5 },
		{ step: 'agent_connected', users: 4 },
		{ step: 'package_forked', users: 3 },
		{ step: 'package_run_succeeded', users: 2 },
		{ step: 'package_activated', users: 1 },
	])
	expect(data.activation.forksByActor).toEqual({
		human: 2,
		agent: 1,
		unknown: 4,
	})
	// user-a: verified 2026-07-01, activated 2026-07-02T12:00 → 36 hours
	expect(data.activation.medianHoursToActivation).toBe(36)
	expect(data.runLogCompleteness).toEqual({
		usersAttempted: 2,
		usersLoaded: 2,
		complete: true,
	})
	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledTimes(2)
	expect(runLogMocks.maxInFlight).toBeLessThanOrEqual(
		adminInsightsRunLogConcurrency,
	)
})

test('multi-user RunLog aggregation sums workflow statuses and milestone users', () => {
	const folded = foldRunLogSnapshots([
		{
			user: {
				stable_user_id: 'u1',
				email_verified_at: '2026-07-01T00:00:00.000Z',
			},
			snapshot: {
				workflowStatusCounts: [
					{ status: 'running', count: 2 },
					{ status: 'complete', count: 1 },
				],
				jobRunCounts: { success: 3, error: 1 },
				activationMilestones: [
					{
						milestone: 'package_run_succeeded',
						reachedAt: '2026-07-01T06:00:00.000Z',
						packageId: 'p1',
					},
					{
						milestone: 'package_activated',
						reachedAt: '2026-07-01T12:00:00.000Z',
						packageId: 'p1',
					},
				],
			},
		},
		{
			user: {
				stable_user_id: 'u2',
				email_verified_at: '2026-07-01T00:00:00.000Z',
			},
			snapshot: {
				workflowStatusCounts: [{ status: 'complete', count: 4 }],
				jobRunCounts: { success: 5, error: 2 },
				activationMilestones: [
					{
						milestone: 'package_run_succeeded',
						reachedAt: '2026-07-02T00:00:00.000Z',
						packageId: 'p2',
					},
				],
			},
		},
		{
			user: {
				stable_user_id: 'u3',
				email_verified_at: null,
			},
			snapshot: null,
		},
	])

	expect(folded.workflowRuns).toBe(7)
	expect(folded.workflowStatuses).toEqual([
		{ status: 'complete', count: 5 },
		{ status: 'running', count: 2 },
	])
	expect(folded.jobSuccessRuns).toBe(8)
	expect(folded.jobErrorRuns).toBe(3)
	expect(folded.packageRunSucceededUsers).toBe(2)
	expect(folded.packageActivatedUsers).toBe(1)
	expect(folded.medianHoursToActivation).toBe(12)
	expect(folded.usersAttempted).toBe(3)
	expect(folded.usersLoaded).toBe(2)
	expect(folded.complete).toBe(false)
})

test('loadAdminInsightsData enumerates only non-deleting users for RunLog reads', async () => {
	consoleWarn.mockImplementation(() => {})
	stubSnapshotsByUser({
		'user-live': emptySnapshot(),
	})
	const db = createInsightsTestDb({
		insightsUsers: [
			{
				stable_user_id: 'user-live',
				email_verified_at: '2026-07-01T00:00:00.000Z',
			},
		],
	})
	await loadAdminInsightsData(
		{
			APP_DB: db,
			AUDIT_DB: db,
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as Env,
		now,
	)

	const userListQuery = db.seenQueries.find((query) =>
		normalizeQuery(query).includes('deleting_at is null'),
	)
	expect(userListQuery).toBeTruthy()
	expect(normalizeQuery(userListQuery ?? '')).toContain('deleting_at is null')
	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledTimes(1)
	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'user-live' }),
	)
	expect(runLogMocks.getAdminInsightsSnapshot).not.toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'user-deleting' }),
	)
})

test('activation latency uses package_activated reachedAt against D1 email_verified_at', async () => {
	consoleWarn.mockImplementation(() => {})
	stubSnapshotsByUser({
		'user-a': {
			workflowStatusCounts: [],
			jobRunCounts: { success: 0, error: 0 },
			activationMilestones: [
				{
					milestone: 'package_activated',
					reachedAt: '2026-07-03T00:00:00.000Z',
					packageId: 'pkg-a',
				},
			],
		},
		'user-b': {
			workflowStatusCounts: [],
			jobRunCounts: { success: 0, error: 0 },
			activationMilestones: [
				{
					milestone: 'package_activated',
					// Before verification — excluded from latency, still counts as activated.
					reachedAt: '2026-07-01T00:00:00.000Z',
					packageId: 'pkg-b',
				},
			],
		},
		'user-c': {
			workflowStatusCounts: [],
			jobRunCounts: { success: 0, error: 0 },
			activationMilestones: [
				{
					milestone: 'package_activated',
					reachedAt: '2026-07-05T00:00:00.000Z',
					packageId: 'pkg-c',
				},
			],
		},
	})
	const db = createInsightsTestDb({
		insightsUsers: [
			{
				stable_user_id: 'user-a',
				email_verified_at: '2026-07-01T00:00:00.000Z',
			},
			{
				stable_user_id: 'user-b',
				email_verified_at: '2026-07-02T00:00:00.000Z',
			},
			{
				stable_user_id: 'user-c',
				email_verified_at: null,
			},
		],
	})
	const data = await loadAdminInsightsData(
		{
			APP_DB: db,
			AUDIT_DB: db,
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as Env,
		now,
	)

	expect(data.activation.steps.at(-1)).toEqual({
		step: 'package_activated',
		users: 3,
	})
	// Only user-a contributes: 48 hours. user-b negative; user-c unverified.
	expect(data.activation.medianHoursToActivation).toBe(48)
	expect(
		hoursFromVerifiedToActivation(
			'2026-07-01T00:00:00.000Z',
			'2026-07-03T00:00:00.000Z',
		),
	).toBe(48)
	expect(
		hoursFromVerifiedToActivation(
			'2026-07-02T00:00:00.000Z',
			'2026-07-01T00:00:00.000Z',
		),
	).toBeNull()
	expect(
		hoursFromVerifiedToActivation(null, '2026-07-05T00:00:00.000Z'),
	).toBeNull()
})

test('degraded RunLog snapshots warn and zero run-derived charts without failing the page', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleWarn.mockClear()
	stubSnapshotsByUser({
		'user-a': new Error('RUN_LOG Durable Object binding is not configured.'),
		'user-b': new Error('rpc failed'),
	})
	const db = createInsightsTestDb()
	const data = await loadAdminInsightsData(
		{
			APP_DB: db,
			AUDIT_DB: db,
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as Env,
		now,
	)

	expect(data.ok).toBe(true)
	expect(data.totals.workflowRuns).toBe(0)
	expect(data.workflowStatuses).toEqual([])
	expect(data.jobHealth).toEqual({
		totalJobs: 4,
		enabledJobs: 3,
		successRuns: 0,
		errorRuns: 0,
	})
	expect(data.activation.steps).toEqual([
		{ step: 'signed_up', users: 8 },
		{ step: 'email_verified', users: 5 },
		{ step: 'agent_connected', users: 4 },
		{ step: 'package_forked', users: 3 },
		{ step: 'package_run_succeeded', users: 0 },
		{ step: 'package_activated', users: 0 },
	])
	expect(data.activation.medianHoursToActivation).toBeNull()
	expect(data.activation.forksByActor).toEqual({
		human: 2,
		agent: 1,
		unknown: 4,
	})
	expect(data.runLogCompleteness).toEqual({
		usersAttempted: 2,
		usersLoaded: 0,
		complete: false,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-insights-run-log-unavailable',
		expect.objectContaining({
			userId: 'user-a',
			error: expect.any(Error),
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-insights-run-log-unavailable',
		expect.objectContaining({
			userId: 'user-b',
			error: expect.any(Error),
		}),
	)
})

test('admin insights uses content-free getAdminInsightsSnapshot point reads only', async () => {
	consoleWarn.mockImplementation(() => {})
	const snapshot: RunLogAdminInsightsSnapshot = {
		workflowStatusCounts: [{ status: 'complete', count: 1 }],
		jobRunCounts: { success: 2, error: 1 },
		activationMilestones: [
			{
				milestone: 'package_run_succeeded',
				reachedAt: '2026-07-02T00:00:00.000Z',
				packageId: 'opaque-pkg',
			},
		],
	}
	stubSnapshotsByUser({
		'user-a': snapshot,
		'user-b': emptySnapshot(),
	})
	const db = createInsightsTestDb()
	const data = await loadAdminInsightsData(
		{
			APP_DB: db,
			AUDIT_DB: db,
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as Env,
		now,
	)

	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledTimes(2)
	for (const call of runLogMocks.getAdminInsightsSnapshot.mock.calls) {
		expect(Object.keys(call[0] ?? {})).toEqual(
			expect.arrayContaining(['env', 'userId']),
		)
		expect(call[0]).not.toHaveProperty('includeContent')
		expect(call[0]).not.toHaveProperty('includeLogs')
	}
	const serialized = JSON.stringify(data)
	expect(serialized).not.toContain('opaque-pkg')
	expect(serialized).not.toMatch(/workflowName|lastError|errorMessage/)
	expect(data.workflowStatuses).toEqual([{ status: 'complete', count: 1 }])
})

test('admin insights source has no legacy D1 run-table SQL', () => {
	const source = readFileSync(
		new URL('./admin-insights-data.ts', import.meta.url),
		'utf8',
	)
	expect(source).not.toMatch(/\bworkflow_runs\b/)
	expect(source).not.toMatch(/\buser_activation_milestones\b/)
	expect(source).not.toMatch(/\buser_package_run_successes\b/)
	expect(source).toMatch(/\bgetAdminInsightsSnapshot\b/)
})

test('loadAdminInsightsData warns when EMAIL_EVENTS binding is missing', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleWarn.mockClear()
	stubSnapshotsByUser({
		'user-a': emptySnapshot(),
		'user-b': emptySnapshot(),
	})
	const db = createInsightsTestDb()
	const data = await loadAdminInsightsData(
		{ APP_DB: db, AUDIT_DB: db } as Env,
		now,
	)

	expect(data.ok).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-insights-email-quota-aggregate-unavailable',
		{ reason: 'missing-email-events-binding' },
	)
	expect(consoleWarn).not.toHaveBeenCalledWith(
		'admin-insights-email-quota-aggregate-unavailable',
		{ reason: 'entitlement-daily-counters-retired-local-dev' },
	)
})

test('admin insights reads email reporting from Analytics Engine and degrades when it is unavailable', async () => {
	stubSnapshotsByUser({
		'user-a': emptySnapshot(),
		'user-b': emptySnapshot(),
	})
	const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		Response.json({
			data: [
				{
					day: '2026-07-08',
					event_type: 'email_send',
					outcome: '',
					n: '7',
				},
				{
					day: '2026-07-08',
					event_type: 'email_receive',
					outcome: '',
					n: 4,
				},
				{
					day: '2026-07-08',
					event_type: 'email_delivery',
					outcome: 'delivered',
					n: '6',
				},
			],
		}),
	)
	const env = {
		APP_DB: createInsightsTestDb(),
		EMAIL_EVENTS: {} as AnalyticsEngineDataset,
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
		SENTRY_ENVIRONMENT: 'preview',
	} as Env
	env.AUDIT_DB = env.APP_DB

	const data = await loadAdminInsightsData(env, now)
	expect(data.emailByDay.at(-1)).toEqual({
		day: '2026-07-08',
		sends: 7,
		receives: 4,
	})
	expect(data.emailDeliveryByDay.at(-1)).toMatchObject({ delivered: 6 })
	expect(fetchSpy).toHaveBeenCalledTimes(1)
	const request = fetchSpy.mock.calls[0]
	expect(request?.[0]).toBe(
		'https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql',
	)
	expect(String(request?.[1]?.body)).toContain('FROM kody_email_events_preview')
	expect(String(request?.[1]?.body)).toContain('sum(_sample_interval)')

	consoleWarn.mockImplementation(() => {})
	fetchSpy.mockResolvedValueOnce(new Response('query failed', { status: 400 }))
	const degraded = await loadAdminInsightsData(env, now)
	expect(degraded.ok).toBe(true)
	expect(degraded.emailByDay.every((day) => day.sends === 0)).toBe(true)
	expect(degraded.emailDeliveryByDay.every((day) => day.failed === 0)).toBe(
		true,
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-insights-email-analytics-unavailable',
		{ error: expect.any(Error) },
	)
	fetchSpy.mockRestore()
})

test('medianOf averages the middle pair and ignores non-finite values', () => {
	expect(medianOf([])).toBeNull()
	expect(medianOf([5])).toBe(5)
	expect(medianOf([1, 3])).toBe(2)
	expect(medianOf([1, 2, 3])).toBe(2)
	expect(medianOf([1, Number.NaN, 3])).toBe(2)
})

test('foldRunLogSnapshots reports complete fanout when every snapshot loads', () => {
	const folded = foldRunLogSnapshots([
		{
			user: {
				stable_user_id: 'u1',
				email_verified_at: '2026-07-01T00:00:00.000Z',
			},
			snapshot: emptySnapshot(),
		},
		{
			user: {
				stable_user_id: 'u2',
				email_verified_at: '2026-07-02T00:00:00.000Z',
			},
			snapshot: emptySnapshot(),
		},
	])

	expect(folded).toMatchObject({
		usersAttempted: 2,
		usersLoaded: 2,
		complete: true,
	})
})

test('loadAdminInsightsData treats a zero-user fleet as complete run-log fanout', async () => {
	consoleWarn.mockImplementation(() => {})
	stubSnapshotsByUser({})
	const db = createInsightsTestDb({ insightsUsers: [] })
	const data = await loadAdminInsightsData(
		{
			APP_DB: db,
			AUDIT_DB: db,
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as Env,
		now,
	)

	expect(data.runLogCompleteness).toEqual({
		usersAttempted: 0,
		usersLoaded: 0,
		complete: true,
	})
	expect(runLogMocks.getAdminInsightsSnapshot).not.toHaveBeenCalled()
})

test('loadAdminInsightsData JSON exposes runLogCompleteness without user content', async () => {
	consoleWarn.mockImplementation(() => {})
	stubSnapshotsByUser({
		'user-a': emptySnapshot(),
		'user-b': new Error('rpc failed'),
	})
	const db = createInsightsTestDb()
	const data = await loadAdminInsightsData(
		{
			APP_DB: db,
			AUDIT_DB: db,
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as Env,
		now,
	)

	const parsed = JSON.parse(JSON.stringify(data)) as typeof data
	expect(parsed.runLogCompleteness).toEqual({
		usersAttempted: 2,
		usersLoaded: 1,
		complete: false,
	})
	expect(Object.keys(parsed.runLogCompleteness).sort()).toEqual([
		'complete',
		'usersAttempted',
		'usersLoaded',
	])
})
