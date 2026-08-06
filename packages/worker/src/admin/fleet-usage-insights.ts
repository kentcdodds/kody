import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	parseStoredPlanName,
	resolveEffectivePlan,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { adminUsageMetrics } from '#worker/admin/user-usage-data.ts'
import { readAdminEntitlementConsumption } from '#worker/admin/entitlement-consumption.ts'
import {
	type AdminInsightsDurationConsumer,
	type AdminInsightsEntitlementPressureUser,
	type AdminInsightsEventCountConsumer,
	type AdminInsightsMetricDurationConsumers,
	type AdminPlanName,
	type AdminUsageMetric,
} from '#app/loader-data.ts'

export const adminFleetTopConsumersLimit = 10

/**
 * Entitlement-pressure sweep and the usage-entitlement alert lane share this
 * bound so fleet reads stay O(1) regardless of user-table size.
 */
export const adminFleetEntitlementSweepUserLimit = 15

export const adminFleetRuntimeDurationMetrics = [
	'execute',
	'job_run',
	'workflow_run',
	'service_runtime',
] as const satisfies ReadonlyArray<AdminUsageMetric>

/**
 * Runtime metrics that can page operators. Persistent `service_runtime` is
 * wall-clock time a package service stayed up — one always-on service crosses
 * 24h in a single day — so it stays on the insights rankings but is excluded
 * from the alert total.
 */
export const adminFleetRuntimeDurationAlertMetrics = [
	'execute',
	'job_run',
	'workflow_run',
] as const satisfies ReadonlyArray<AdminUsageMetric>

/**
 * Combined current-month execute + job_run + workflow_run duration above which
 * a non-admin account warrants operator review. 24h of metered sandbox / job /
 * workflow wall-clock in one UTC month is a practical "heavy but not
 * necessarily abusive" ceiling before paging. Admin accounts are omitted from
 * this signal so operator dogfooding does not page the on-call roster.
 */
export const fleetRuntimeDurationAlertThresholdMs = 24 * 60 * 60 * 1000

const entitlementSweepConcurrency = 4

type RuntimeDurationRow = {
	user_id: string
	total_duration_ms: number
}

type ActiveUserRow = {
	stable_user_id: string
	username: string
	plan: string
	stripe_plan: string | null
	event_count: number
}

type MetricDurationRow = {
	user_id: string
	metric: string
	total_duration_ms: number
}

export type FleetEntitlementPressureIssue =
	| {
			kind: 'entitlement'
			stableUserId: string
			username: string
			resource: string
			label: string
			percentOfLimit: number
	  }
	| {
			kind: 'runtime_duration'
			stableUserId: string
			username: string
			totalDurationMs: number
	  }

export async function loadFleetUsageInsights(input: {
	db: D1Database
	env: Env
	now: Date
}): Promise<{
	topRuntimeDurationConsumers: Array<AdminInsightsDurationConsumer>
	topEventCountConsumers: Array<AdminInsightsEventCountConsumer>
	topDurationConsumersByMetric: Array<AdminInsightsMetricDurationConsumers>
	entitlementPressure: Array<AdminInsightsEntitlementPressureUser>
}> {
	const currentMonth = utcMonthKey(input.now)
	const [
		topRuntimeDurationConsumers,
		topEventCountConsumers,
		topDurationConsumersByMetric,
		entitlementPressure,
	] = await Promise.all([
		queryTopRuntimeDurationConsumers(input.db, currentMonth),
		queryTopEventCountConsumers(input.db, currentMonth),
		queryTopDurationConsumersByMetric(input.db, currentMonth),
		buildEntitlementPressurePanel(input),
	])
	return {
		topRuntimeDurationConsumers,
		topEventCountConsumers,
		topDurationConsumersByMetric,
		entitlementPressure,
	}
}

export async function detectFleetUsagePressure(input: {
	db: D1Database
	env: Env
	now: Date
	runtimeDurationThresholdMs?: number
}): Promise<Array<FleetEntitlementPressureIssue>> {
	const runtimeDurationThresholdMs =
		input.runtimeDurationThresholdMs ?? fleetRuntimeDurationAlertThresholdMs
	const currentMonth = utcMonthKey(input.now)
	const activeUsers = await listActiveUsersForEntitlementSweep(
		input.db,
		currentMonth,
	)
	if (activeUsers.length === 0) return []

	const [durationByUser, adminUserIds] = await Promise.all([
		queryCombinedRuntimeDurationByUserIds(
			input.db,
			currentMonth,
			activeUsers.map((user) => user.stable_user_id),
			adminFleetRuntimeDurationAlertMetrics,
		),
		listAdminStableUserIds(input.db),
	])
	const issues: Array<FleetEntitlementPressureIssue> = []

	await mapWithConcurrency(
		activeUsers,
		entitlementSweepConcurrency,
		async (user) => {
			const plan = resolveEffectivePlan(
				parseStoredPlanName(user.plan),
				user.stripe_plan,
			)
			const consumption = await readAdminEntitlementConsumption({
				env: input.env,
				usageUserId: user.stable_user_id,
				plan,
				now: input.now,
			})
			for (const item of consumption) {
				if (!item.overEightyPercent || item.percentOfLimit == null) continue
				issues.push({
					kind: 'entitlement',
					stableUserId: user.stable_user_id,
					username: user.username,
					resource: item.resource,
					label: item.label,
					percentOfLimit: item.percentOfLimit,
				})
			}
			if (adminUserIds.has(user.stable_user_id)) return
			const totalDurationMs = durationByUser.get(user.stable_user_id) ?? 0
			if (totalDurationMs > runtimeDurationThresholdMs) {
				issues.push({
					kind: 'runtime_duration',
					stableUserId: user.stable_user_id,
					username: user.username,
					totalDurationMs,
				})
			}
		},
	)

	return issues.sort((left, right) =>
		left.stableUserId.localeCompare(right.stableUserId),
	)
}

async function queryTopRuntimeDurationConsumers(
	db: D1Database,
	currentMonth: string,
): Promise<Array<AdminInsightsDurationConsumer>> {
	const metricPlaceholders = adminFleetRuntimeDurationMetrics
		.map(() => '?')
		.join(', ')
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id, u.username, ranked.total_duration_ms
			 FROM (
				SELECT user_id, SUM(total_duration_ms) AS total_duration_ms
				FROM usage_rollups
				WHERE month = ?
					AND metric IN (${metricPlaceholders})
				GROUP BY user_id
				ORDER BY total_duration_ms DESC
				LIMIT ?
			 ) AS ranked
			 INNER JOIN users u ON u.stable_user_id = ranked.user_id
			 WHERE u.deleting_at IS NULL
			 ORDER BY ranked.total_duration_ms DESC`,
		)
		.bind(
			currentMonth,
			...adminFleetRuntimeDurationMetrics,
			adminFleetTopConsumersLimit,
		)
		.all<{
			stable_user_id: string
			username: string
			total_duration_ms: number
		}>()
	return (rows.results ?? []).map((row) => ({
		stableUserId: row.stable_user_id,
		username: row.username,
		totalDurationMs: Number(row.total_duration_ms),
	}))
}

async function queryTopEventCountConsumers(
	db: D1Database,
	currentMonth: string,
): Promise<Array<AdminInsightsEventCountConsumer>> {
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id, u.username, ranked.event_count
			 FROM (
				SELECT user_id, SUM(event_count) AS event_count
				FROM usage_rollups
				WHERE month = ?
				GROUP BY user_id
				ORDER BY event_count DESC
				LIMIT ?
			 ) AS ranked
			 INNER JOIN users u ON u.stable_user_id = ranked.user_id
			 WHERE u.deleting_at IS NULL
			 ORDER BY ranked.event_count DESC`,
		)
		.bind(currentMonth, adminFleetTopConsumersLimit)
		.all<{ stable_user_id: string; username: string; event_count: number }>()
	return (rows.results ?? []).map((row) => ({
		stableUserId: row.stable_user_id,
		username: row.username,
		eventCount: Number(row.event_count),
	}))
}

async function queryTopDurationConsumersByMetric(
	db: D1Database,
	currentMonth: string,
): Promise<Array<AdminInsightsMetricDurationConsumers>> {
	const metricPlaceholders = adminFleetRuntimeDurationMetrics
		.map(() => '?')
		.join(', ')
	const rows = await db
		.prepare(
			`SELECT ranked.user_id, ranked.metric, ranked.total_duration_ms, u.username
			 FROM (
				SELECT user_id, metric, total_duration_ms,
					ROW_NUMBER() OVER (
						PARTITION BY metric
						ORDER BY total_duration_ms DESC
					) AS rank_in_metric
				FROM usage_rollups
				WHERE month = ?
					AND metric IN (${metricPlaceholders})
					AND total_duration_ms > 0
			 ) AS ranked
			 INNER JOIN users u ON u.stable_user_id = ranked.user_id
			 WHERE ranked.rank_in_metric <= ?
				AND u.deleting_at IS NULL
			 ORDER BY ranked.metric ASC, ranked.total_duration_ms DESC`,
		)
		.bind(
			currentMonth,
			...adminFleetRuntimeDurationMetrics,
			adminFleetTopConsumersLimit,
		)
		.all<MetricDurationRow & { username: string }>()

	const byMetric = new Map<
		AdminUsageMetric,
		Array<AdminInsightsDurationConsumer>
	>()
	for (const metric of adminFleetRuntimeDurationMetrics) {
		byMetric.set(metric, [])
	}
	for (const row of rows.results ?? []) {
		if (!isAdminUsageMetric(row.metric)) continue
		const consumers = byMetric.get(row.metric)
		if (!consumers) continue
		consumers.push({
			stableUserId: row.user_id,
			username: row.username,
			totalDurationMs: Number(row.total_duration_ms),
		})
	}
	return adminFleetRuntimeDurationMetrics.map((metric) => ({
		metric,
		consumers: byMetric.get(metric) ?? [],
	}))
}

async function buildEntitlementPressurePanel(input: {
	db: D1Database
	env: Env
	now: Date
}): Promise<Array<AdminInsightsEntitlementPressureUser>> {
	const currentMonth = utcMonthKey(input.now)
	const activeUsers = await listActiveUsersForEntitlementSweep(
		input.db,
		currentMonth,
	)
	if (activeUsers.length === 0) return []

	const pressured: Array<AdminInsightsEntitlementPressureUser> = []
	await mapWithConcurrency(
		activeUsers,
		entitlementSweepConcurrency,
		async (user) => {
			const plan = toAdminPlanName(
				resolveEffectivePlan(parseStoredPlanName(user.plan), user.stripe_plan),
			)
			const consumption = await readAdminEntitlementConsumption({
				env: input.env,
				usageUserId: user.stable_user_id,
				plan,
				now: input.now,
			})
			const pressuredResources = consumption
				.filter((item) => item.overEightyPercent && item.percentOfLimit != null)
				.map((item) => ({
					resource: item.resource,
					label: item.label,
					current: item.current,
					limit: item.limit,
					percentOfLimit: item.percentOfLimit!,
				}))
			if (pressuredResources.length === 0) return
			pressured.push({
				stableUserId: user.stable_user_id,
				username: user.username,
				plan,
				pressuredResources,
			})
		},
	)

	return pressured.sort(
		(left, right) =>
			right.pressuredResources.length - left.pressuredResources.length ||
			left.username.localeCompare(right.username),
	)
}

async function listActiveUsersForEntitlementSweep(
	db: D1Database,
	currentMonth: string,
): Promise<Array<ActiveUserRow>> {
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id, u.username, u.plan, u.stripe_plan, ranked.event_count
			 FROM (
				SELECT user_id, SUM(event_count) AS event_count
				FROM usage_rollups
				WHERE month = ?
				GROUP BY user_id
				ORDER BY event_count DESC
				LIMIT ?
			 ) AS ranked
			 INNER JOIN users u ON u.stable_user_id = ranked.user_id
			 WHERE u.deleting_at IS NULL
			 ORDER BY ranked.event_count DESC`,
		)
		.bind(currentMonth, adminFleetEntitlementSweepUserLimit)
		.all<ActiveUserRow>()
	return rows.results ?? []
}

async function listAdminStableUserIds(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id
			 FROM users u
			 INNER JOIN user_roles ur ON ur.user_id = u.id
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE r.name = 'admin'
				AND u.deleting_at IS NULL`,
		)
		.all<{ stable_user_id: string }>()
	return new Set((rows.results ?? []).map((row) => row.stable_user_id))
}

async function queryCombinedRuntimeDurationByUserIds(
	db: D1Database,
	currentMonth: string,
	userIds: ReadonlyArray<string>,
	metrics: ReadonlyArray<AdminUsageMetric> = adminFleetRuntimeDurationMetrics,
): Promise<Map<string, number>> {
	if (userIds.length === 0) return new Map()
	const metricPlaceholders = metrics.map(() => '?').join(', ')
	const userPlaceholders = userIds.map(() => '?').join(', ')
	const rows = await db
		.prepare(
			`SELECT user_id, SUM(total_duration_ms) AS total_duration_ms
			 FROM usage_rollups
			 WHERE month = ?
				AND metric IN (${metricPlaceholders})
				AND user_id IN (${userPlaceholders})
			 GROUP BY user_id`,
		)
		.bind(currentMonth, ...metrics, ...userIds)
		.all<RuntimeDurationRow>()
	const byUser = new Map<string, number>()
	for (const row of rows.results ?? []) {
		byUser.set(row.user_id, Number(row.total_duration_ms))
	}
	return byUser
}

function toAdminPlanName(plan: PlanName): AdminPlanName {
	return plan
}

function isAdminUsageMetric(metric: string): metric is AdminUsageMetric {
	return (adminUsageMetrics as ReadonlyArray<string>).includes(metric)
}

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return
	const limit = Math.max(1, Math.min(concurrency, items.length))
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (item === undefined) return
				await mapper(item)
			}
		}),
	)
}
