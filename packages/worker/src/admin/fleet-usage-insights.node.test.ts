import { expect, test, vi } from 'vitest'

const entitlementMocks = vi.hoisted(() => ({
	readAdminEntitlementConsumption: vi.fn(),
}))

vi.mock('#worker/admin/entitlement-consumption.ts', () => ({
	readAdminEntitlementConsumption:
		entitlementMocks.readAdminEntitlementConsumption,
	entitlementWarningThreshold: 0.8,
}))

const {
	adminFleetEntitlementSweepUserLimit,
	adminFleetTopConsumersLimit,
	detectFleetUsagePressure,
	fleetRuntimeDurationAlertThresholdMs,
	loadFleetUsageInsights,
} = await import('#worker/admin/fleet-usage-insights.ts')

function createFleetDb(input: {
	runtimeLeaders?: Array<{
		stable_user_id: string
		username: string
		total_duration_ms: number
	}>
	eventLeaders?: Array<{
		stable_user_id: string
		username: string
		event_count: number
	}>
	metricLeaders?: Array<{
		user_id: string
		username: string
		metric: string
		total_duration_ms: number
	}>
	activeUsers?: Array<{
		stable_user_id: string
		username: string
		plan: string
		stripe_plan: string | null
		event_count: number
	}>
	runtimeByUser?: Record<string, number>
}) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(..._params: Array<unknown>) {
					return this
				},
				async all<T>() {
					if (
						normalized.includes('sum(total_duration_ms)') &&
						normalized.includes('group by user_id') &&
						normalized.includes('limit ?') &&
						!normalized.includes('partition by metric')
					) {
						return {
							results: (input.runtimeLeaders ?? []) as Array<T>,
						}
					}
					if (
						normalized.includes('u.plan') &&
						normalized.includes('ranked.event_count')
					) {
						return {
							results: (input.activeUsers ?? []) as Array<T>,
						}
					}
					if (
						normalized.includes('sum(event_count)') &&
						normalized.includes('group by user_id') &&
						normalized.includes('limit ?')
					) {
						return {
							results: (input.eventLeaders ?? []) as Array<T>,
						}
					}
					if (normalized.includes('row_number() over')) {
						return {
							results: (input.metricLeaders ?? []) as Array<T>,
						}
					}
					if (
						normalized.includes('sum(total_duration_ms)') &&
						normalized.includes('user_id in')
					) {
						const rows = Object.entries(input.runtimeByUser ?? {}).map(
							([user_id, total_duration_ms]) => ({
								user_id,
								total_duration_ms,
							}),
						)
						return { results: rows as Array<T> }
					}
					throw new Error(`Unsupported fleet query: ${query}`)
				},
			}
		},
	} as unknown as D1Database
}

test('loadFleetUsageInsights returns bounded consumer rankings and pressure panel', async () => {
	entitlementMocks.readAdminEntitlementConsumption.mockResolvedValue([
		{
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9,
			limit: 10,
			percentOfLimit: 0.9,
			overEightyPercent: true,
		},
	])
	const db = createFleetDb({
		runtimeLeaders: [
			{
				stable_user_id: 'user-a',
				username: 'alice',
				total_duration_ms: 3_600_000,
			},
		],
		eventLeaders: [
			{
				stable_user_id: 'user-b',
				username: 'bob',
				event_count: 42,
			},
		],
		metricLeaders: [
			{
				user_id: 'user-a',
				username: 'alice',
				metric: 'execute',
				total_duration_ms: 1_000,
			},
		],
		activeUsers: [
			{
				stable_user_id: 'user-a',
				username: 'alice',
				plan: 'free',
				stripe_plan: null,
				event_count: 50,
			},
		],
	})
	const data = await loadFleetUsageInsights({
		db,
		env: { APP_DB: db } as Env,
		now: new Date('2026-07-08T12:00:00.000Z'),
	})
	expect(data.topRuntimeDurationConsumers).toEqual([
		{
			stableUserId: 'user-a',
			username: 'alice',
			totalDurationMs: 3_600_000,
		},
	])
	expect(data.topEventCountConsumers).toEqual([
		{
			stableUserId: 'user-b',
			username: 'bob',
			eventCount: 42,
		},
	])
	expect(data.topDurationConsumersByMetric).toHaveLength(4)
	expect(data.topDurationConsumersByMetric[0]?.consumers).toEqual([
		{
			stableUserId: 'user-a',
			username: 'alice',
			totalDurationMs: 1_000,
		},
	])
	expect(data.entitlementPressure).toEqual([
		{
			stableUserId: 'user-a',
			username: 'alice',
			plan: 'free',
			pressuredResources: [
				{
					resource: 'saved_packages',
					label: 'saved packages',
					current: 9,
					limit: 10,
					percentOfLimit: 0.9,
				},
			],
		},
	])
})

test('detectFleetUsagePressure flags entitlement and runtime duration thresholds', async () => {
	entitlementMocks.readAdminEntitlementConsumption.mockImplementation(
		async (input) => {
			if (input.usageUserId === 'user-a') {
				return [
					{
						resource: 'secrets',
						label: 'secrets',
						current: 9,
						limit: 10,
						percentOfLimit: 0.9,
						overEightyPercent: true,
					},
				]
			}
			return []
		},
	)
	const db = createFleetDb({
		activeUsers: [
			{
				stable_user_id: 'user-a',
				username: 'alice',
				plan: 'free',
				stripe_plan: null,
				event_count: 50,
			},
			{
				stable_user_id: 'user-b',
				username: 'bob',
				plan: 'pro',
				stripe_plan: null,
				event_count: 40,
			},
		],
		runtimeByUser: {
			'user-b': fleetRuntimeDurationAlertThresholdMs + 1,
		},
	})
	const issues = await detectFleetUsagePressure({
		db,
		env: { APP_DB: db } as Env,
		now: new Date('2026-07-08T12:00:00.000Z'),
	})
	expect(issues).toEqual([
		{
			kind: 'entitlement',
			stableUserId: 'user-a',
			username: 'alice',
			resource: 'secrets',
			label: 'secrets',
			percentOfLimit: 0.9,
		},
		{
			kind: 'runtime_duration',
			stableUserId: 'user-b',
			username: 'bob',
			totalDurationMs: fleetRuntimeDurationAlertThresholdMs + 1,
		},
	])
	expect(adminFleetTopConsumersLimit).toBe(10)
	expect(adminFleetEntitlementSweepUserLimit).toBe(15)
})
