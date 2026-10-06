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
	detectFleetUsagePressure,
	fleetRuntimeDurationAlertThresholdMs,
	loadFleetEntitlementCrossingSnapshots,
	loadFleetUsageInsights,
} = await import('#worker/admin/fleet-usage-insights.ts')

type ActiveUserRow = {
	stable_user_id: string
	username: string
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stripe_credits_eligible?: number | null
	admin_credits_eligible?: number | null
	second_agent_standard_gift_expires_at?: string | null
	referral_standard_credit_expires_at?: string | null
	event_count: number
}

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
	activeUsers?: Array<ActiveUserRow>
	runtimeByUser?: Record<string, number>
	adminUserIds?: Array<string>
	dynamicWorkerLeaders?: Array<{
		stable_user_id: string
		username: string
		event_count: number
	}>
	dynamicWorkerDays?: number
	uniqueWorkerDaysByUser?: Record<string, number>
	onDurationQueryBind?: (params: Array<unknown>) => void
	onEventCountQueryBind?: (params: Array<unknown>) => void
}) {
	const byUser = (record: Record<string, number> | undefined, key: string) =>
		Object.entries(record ?? {}).map(([user_id, value]) => ({
			user_id,
			[key]: value,
		}))
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			const has = (...parts: Array<string>) =>
				parts.every((part) => normalized.includes(part))
			const dynamicWorkerDay = "metric = 'dynamic_worker_day'"
			return {
				bind(...params: Array<unknown>) {
					if (has('sum(total_duration_ms)', 'user_id in')) {
						input.onDurationQueryBind?.(params)
					}
					if (has('sum(r.event_count)', 'not in')) {
						input.onEventCountQueryBind?.(params)
					}
					return this
				},
				async first<T>() {
					return has(dynamicWorkerDay, 'sum(event_count)')
						? ({ unique_worker_days: input.dynamicWorkerDays ?? 0 } as T)
						: null
				},
				async all<T>() {
					const routes: Array<[boolean, Array<unknown> | undefined]> = [
						[
							has('sum(r.total_duration_ms)', 'limit ?') &&
								!has('partition by'),
							input.runtimeLeaders,
						],
						[
							has('u.plan', 'entitlement_ladder', 'event_count'),
							input.activeUsers,
						],
						[
							has("r.name = 'admin'", 'stable_user_id'),
							input.adminUserIds?.map((stable_user_id) => ({ stable_user_id })),
						],
						[has('sum(r.event_count)', 'limit ?'), input.eventLeaders],
						[
							has(dynamicWorkerDay, 'user_id in'),
							byUser(input.uniqueWorkerDaysByUser, 'event_count'),
						],
						[has(dynamicWorkerDay, 'limit ?'), input.dynamicWorkerLeaders],
						[has('row_number() over'), input.metricLeaders],
						[
							has('sum(total_duration_ms)', 'user_id in'),
							byUser(input.runtimeByUser, 'total_duration_ms'),
						],
					]
					const route = routes.find(([matches]) => matches)
					if (!route) throw new Error(`Unsupported fleet query: ${query}`)
					return { results: (route[1] ?? []) as Array<T> }
				},
			}
		},
	} as unknown as D1Database
}

function activeUser(
	stable_user_id: string,
	username: string,
	plan: string,
	event_count: number,
	overrides: Partial<ActiveUserRow> = {},
): ActiveUserRow {
	return {
		stable_user_id,
		username,
		plan,
		stripe_plan: null,
		entitlement_ladder: 'public',
		stripe_credits_eligible: 0,
		admin_credits_eligible: 0,
		second_agent_standard_gift_expires_at: null,
		referral_standard_credit_expires_at: null,
		event_count,
		...overrides,
	}
}

function consumption(
	resource: string,
	label: string,
	current: number,
	limit: number,
) {
	const percentOfLimit = current / limit
	return {
		resource,
		label,
		current,
		limit,
		percentOfLimit,
		overEightyPercent: percentOfLimit > 0.8,
	}
}

function consumptionCalls() {
	return entitlementMocks.readAdminEntitlementConsumption.mock.calls.map(
		([input]) => ({
			usageUserId: input.usageUserId,
			plan: input.plan,
			ladder: input.ladder,
		}),
	)
}

const now = new Date('2026-07-08T12:00:00.000Z')

test('loadFleetUsageInsights returns bounded consumer rankings and pressure panel', async () => {
	entitlementMocks.readAdminEntitlementConsumption.mockResolvedValue([
		consumption('saved_packages', 'saved packages', 9, 10),
	])
	const eventCountBinds: Array<Array<unknown>> = []
	const db = createFleetDb({
		runtimeLeaders: [
			{
				stable_user_id: 'user-a',
				username: 'alice',
				total_duration_ms: 3_600_000,
			},
		],
		eventLeaders: [
			{ stable_user_id: 'user-b', username: 'bob', event_count: 42 },
		],
		metricLeaders: [
			{
				user_id: 'user-a',
				username: 'alice',
				metric: 'execute',
				total_duration_ms: 1_000,
			},
		],
		activeUsers: [activeUser('user-a', 'alice', 'free', 50)],
		dynamicWorkerDays: 150,
		dynamicWorkerLeaders: [
			{ stable_user_id: 'user-c', username: 'cara', event_count: 90 },
		],
		onEventCountQueryBind(params) {
			eventCountBinds.push(params)
		},
	})
	const data = await loadFleetUsageInsights({
		db,
		env: { APP_DB: db } as Env,
		now,
	})
	expect(data.topRuntimeDurationConsumers).toEqual([
		{ stableUserId: 'user-a', username: 'alice', totalDurationMs: 3_600_000 },
	])
	expect(data.topEventCountConsumers).toEqual([
		{ stableUserId: 'user-b', username: 'bob', eventCount: 42 },
	])
	expect(eventCountBinds.length).toBeGreaterThan(0)
	expect(eventCountBinds[0]?.slice(1, 6)).toEqual([
		'dynamic_worker_invoke',
		'dynamic_worker_cpu',
		'durable_object_gb_seconds',
		'durable_object_rows_read',
		'durable_object_platform_rows_read',
	])
	expect(data.topDurationConsumersByMetric).toHaveLength(3)
	expect(data.topDurationConsumersByMetric[0]?.consumers).toEqual([
		{ stableUserId: 'user-a', username: 'alice', totalDurationMs: 1_000 },
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
	expect(data.dynamicWorkerCost).toEqual({
		uniqueWorkerDays: 150,
		estimatedGrossUsd: 0.3,
		usdPerUniqueDay: 0.002,
		includedPerAccountMonth: 1000,
		topConsumers: [
			{
				stableUserId: 'user-c',
				username: 'cara',
				uniqueWorkerDays: 90,
				estimatedGrossUsd: 0.18,
				estimatedPaidUsdCents: 0,
				estimatedMarginUsd: -0.18,
				underwater: false,
				paidSource: 'none',
				risk: 'none',
			},
		],
		riskConsumers: [],
	})
})

test('detectFleetUsagePressure flags entitlement, runtime, and unique-worker cost', async () => {
	const consumptionByUser: Record<
		string,
		Array<ReturnType<typeof consumption>>
	> = {
		'user-a': [consumption('secrets', 'secrets', 9, 10)],
		'user-admin': [
			consumption('saved_packages', 'saved packages', 9_001, 10_000),
		],
	}
	entitlementMocks.readAdminEntitlementConsumption.mockImplementation(
		async (input) => consumptionByUser[input.usageUserId] ?? [],
	)
	let durationQueryBind: Array<unknown> | undefined
	const db = createFleetDb({
		activeUsers: [
			activeUser('user-a', 'alice', 'free', 50),
			activeUser('user-b', 'bob', 'pro', 40),
			activeUser('user-admin', 'kentcdodds', 'max', 90),
		],
		adminUserIds: ['user-admin'],
		runtimeByUser: {
			'user-b': fleetRuntimeDurationAlertThresholdMs + 1,
			'user-admin': fleetRuntimeDurationAlertThresholdMs * 2,
		},
		uniqueWorkerDaysByUser: {
			'user-a': 1000,
			'user-admin': 50_000,
		},
		onDurationQueryBind(params) {
			durationQueryBind = params
		},
	})
	const issues = await detectFleetUsagePressure({
		db,
		env: { APP_DB: db } as Env,
		now,
	})
	expect(issues).toEqual([
		{
			kind: 'entitlement',
			stableUserId: 'user-a',
			username: 'alice',
			resource: 'secrets',
			label: 'secrets',
			current: 9,
			limit: 10,
			percentOfLimit: 0.9,
		},
		{
			kind: 'dynamic_worker_cost',
			stableUserId: 'user-a',
			username: 'alice',
			uniqueWorkerDays: 1000,
			estimatedGrossUsd: 2,
			thresholdUsd: 2,
		},
		{
			kind: 'entitlement',
			stableUserId: 'user-admin',
			username: 'kentcdodds',
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9_001,
			limit: 10_000,
			percentOfLimit: 0.9001,
		},
		{
			kind: 'runtime_duration',
			stableUserId: 'user-b',
			username: 'bob',
			totalDurationMs: fleetRuntimeDurationAlertThresholdMs + 1,
		},
	])
	expect(durationQueryBind?.slice(1, 4)).toEqual([
		'execute',
		'job_run',
		'workflow_run',
	])
	expect(consumptionCalls()).toEqual(
		expect.arrayContaining([
			{ usageUserId: 'user-a', plan: 'free', ladder: 'public' },
			{ usageUserId: 'user-b', plan: 'pro', ladder: 'public' },
			{ usageUserId: 'user-admin', plan: 'max', ladder: 'public' },
		]),
	)
})

test('fleet entitlement pressure scores legacy Standard against the legacy outbound ceiling', async () => {
	const outboundCurrent = 15_016
	const publicStandardOutboundLimit = 5_000
	const legacyStandardOutboundLimit = 20_000
	entitlementMocks.readAdminEntitlementConsumption.mockImplementation(
		async (input) => [
			consumption(
				'outbound_fetches_per_day',
				'outbound fetches / day',
				outboundCurrent,
				input.ladder === 'legacy'
					? legacyStandardOutboundLimit
					: publicStandardOutboundLimit,
			),
		],
	)
	const standard = { stripe_plan: 'standard' }
	const db = createFleetDb({
		activeUsers: [
			activeUser('grant', 'grant', 'standard', 80, {
				...standard,
				entitlement_ladder: 'legacy',
			}),
			activeUser('pat', 'pat', 'standard', 70, standard),
		],
	})
	const env = { APP_DB: db } as Env
	const [snapshots, issues, insights] = await Promise.all([
		loadFleetEntitlementCrossingSnapshots({ db, env, now }),
		detectFleetUsagePressure({ db, env, now }),
		loadFleetUsageInsights({ db, env, now }),
	])
	expect(consumptionCalls()).toEqual(
		expect.arrayContaining([
			{ usageUserId: 'grant', plan: 'standard', ladder: 'legacy' },
			{ usageUserId: 'pat', plan: 'standard', ladder: 'public' },
		]),
	)
	const outboundSnapshot = (limit: number, overEightyPercent: boolean) => [
		expect.objectContaining({
			resource: 'outbound_fetches_per_day',
			current: outboundCurrent,
			limit,
			overEightyPercent,
		}),
	]
	expect(snapshots).toEqual([
		expect.objectContaining({
			stableUserId: 'grant',
			plan: 'standard',
			ladder: 'legacy',
			entitlements: outboundSnapshot(legacyStandardOutboundLimit, false),
		}),
		expect.objectContaining({
			stableUserId: 'pat',
			plan: 'standard',
			ladder: 'public',
			entitlements: outboundSnapshot(publicStandardOutboundLimit, true),
		}),
	])
	const patPressure = {
		resource: 'outbound_fetches_per_day',
		label: 'outbound fetches / day',
		current: outboundCurrent,
		limit: publicStandardOutboundLimit,
		percentOfLimit: outboundCurrent / publicStandardOutboundLimit,
	}
	expect(issues).toEqual([
		{
			kind: 'entitlement',
			stableUserId: 'pat',
			username: 'pat',
			...patPressure,
		},
	])
	expect(insights.entitlementPressure).toEqual([
		{
			stableUserId: 'pat',
			username: 'pat',
			plan: 'standard',
			pressuredResources: [patPressure],
		},
	])
})

test('fleet entitlement pressure scores temporary Pro gift overlays, not Free caps', async () => {
	const packagesOverFree = 15
	const freePackageLimit = 10
	const publicProPackageLimit = 200
	entitlementMocks.readAdminEntitlementConsumption.mockImplementation(
		async (input) => {
			const limit =
				input.plan === 'free' ? freePackageLimit : publicProPackageLimit
			return [
				consumption(
					'saved_packages',
					'saved packages',
					packagesOverFree,
					limit,
				),
			]
		},
	)
	const giftExpiresAt = '2026-07-20T00:00:00.000Z'
	const db = createFleetDb({
		activeUsers: [
			activeUser('gifted', 'continuumpraxis', 'free', 90, {
				second_agent_standard_gift_expires_at: giftExpiresAt,
			}),
			activeUser('base-free', 'freefolk', 'free', 80),
			activeUser('expired-gift', 'pastgift', 'free', 70, {
				second_agent_standard_gift_expires_at: '2026-07-01T00:00:00.000Z',
			}),
			activeUser('referral-gift', 'referred', 'free', 60, {
				referral_standard_credit_expires_at: giftExpiresAt,
			}),
		],
	})
	const env = { APP_DB: db } as Env
	const [snapshots, issues, insights] = await Promise.all([
		loadFleetEntitlementCrossingSnapshots({ db, env, now }),
		detectFleetUsagePressure({ db, env, now }),
		loadFleetUsageInsights({ db, env, now }),
	])

	expect(consumptionCalls()).toEqual(
		expect.arrayContaining([
			{ usageUserId: 'gifted', plan: 'pro', ladder: 'public' },
			{ usageUserId: 'base-free', plan: 'free', ladder: 'public' },
			{ usageUserId: 'expired-gift', plan: 'free', ladder: 'public' },
			{ usageUserId: 'referral-gift', plan: 'pro', ladder: 'public' },
		]),
	)

	expect(snapshots).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				stableUserId: 'gifted',
				plan: 'pro',
				entitlements: [
					expect.objectContaining({
						resource: 'saved_packages',
						current: packagesOverFree,
						limit: publicProPackageLimit,
						overEightyPercent: false,
					}),
				],
			}),
			expect.objectContaining({
				stableUserId: 'base-free',
				plan: 'free',
				entitlements: [
					expect.objectContaining({
						resource: 'saved_packages',
						current: packagesOverFree,
						limit: freePackageLimit,
						overEightyPercent: true,
					}),
				],
			}),
			expect.objectContaining({
				stableUserId: 'expired-gift',
				plan: 'free',
				entitlements: [
					expect.objectContaining({
						limit: freePackageLimit,
						overEightyPercent: true,
					}),
				],
			}),
			expect.objectContaining({
				stableUserId: 'referral-gift',
				plan: 'pro',
				entitlements: [
					expect.objectContaining({
						limit: publicProPackageLimit,
						overEightyPercent: false,
					}),
				],
			}),
		]),
	)

	const freePressure = {
		kind: 'entitlement' as const,
		resource: 'saved_packages',
		label: 'saved packages',
		current: packagesOverFree,
		limit: freePackageLimit,
		percentOfLimit: packagesOverFree / freePackageLimit,
	}
	expect(issues).toEqual(
		expect.arrayContaining([
			{ ...freePressure, stableUserId: 'base-free', username: 'freefolk' },
			{ ...freePressure, stableUserId: 'expired-gift', username: 'pastgift' },
		]),
	)
	expect(issues).not.toEqual(
		expect.arrayContaining([
			expect.objectContaining({ stableUserId: 'gifted' }),
			expect.objectContaining({ stableUserId: 'referral-gift' }),
		]),
	)
	expect(
		insights.entitlementPressure.map((row) => row.stableUserId).sort(),
	).toEqual(['base-free', 'expired-gift'])
})
