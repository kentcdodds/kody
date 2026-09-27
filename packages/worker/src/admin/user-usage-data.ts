import { cachified, type Cache } from '@epic-web/cachified'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { toAdminDynamicWorkerCost } from '#universal/dynamic-worker-cost.ts'
import {
	toAdminDurableObjectDuration,
	toAdminMeasuredDurableObjectDuration,
} from '#universal/durable-object-duration.ts'
import {
	type AdminUsageMetric,
	type AdminUsageMonthRollup,
	type AdminUsageRollup,
	type AdminUserUsageLoaderData,
} from '#universal/loader-data.ts'
import { resolvePlanLimits } from '#universal/plans.ts'
import { toAdminCostVsPay } from '#worker/admin/cost-vs-pay.ts'
import { readAdminEntitlementConsumption } from '#worker/admin/entitlement-consumption.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { resolveStripePriceCatalog } from '#worker/billing/stripe-price-catalog.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { resolveUserStableId } from '#worker/user-id.ts'

export const adminUsageMetrics = [
	'execute',
	'package_export',
	'package_static_call',
	'job_run',
	'workflow_run',
	'outbound_fetch',
	'email_send',
	'email_received',
	'dynamic_worker_day',
	'dynamic_worker_cpu',
	'durable_object_gb_seconds',
	'durable_object_rows_read',
	'durable_object_platform_rows_read',
] as const satisfies ReadonlyArray<AdminUsageMetric>

/**
 * Rollup rows are derived hourly from Analytics Engine in production, so a
 * short KV cache on the per-user read model adds no meaningful staleness
 * while keeping repeated admin drill-down loads off D1.
 */
const rollupCacheTtlMs = 5 * 60 * 1000

type AdminUserUsageUserRow = UserEntitlementRow & {
	id: number
	username: string
	email: string
	stripe_price_id: string | null
	stable_user_id: string
}

type AdminUsageRollupRow = {
	user_id: string
	metric: string
	month: string
	event_count: number
	error_count: number
	total_duration_ms: number
	total_cpu_ms: number
	total_bytes: number
}

/**
 * Usage drill-down for one account: month-over-month usage rollups plus
 * current entitlement consumption against plan limits. Reads a fixed,
 * small number of counters for exactly one user, so cost does not grow
 * with the size of the user base. Returns null when no user matches.
 */
export async function loadAdminUserUsageData(
	env: Env,
	stableUserId: string,
	now: Date = new Date(),
): Promise<AdminUserUsageLoaderData | null> {
	const row = await env.APP_DB.prepare(
		`SELECT id, username, email, stripe_price_id, stable_user_id, ${userEntitlementColumnsSql()}
		 FROM users WHERE stable_user_id = ?`,
	)
		.bind(stableUserId)
		.first<AdminUserUsageUserRow>()
	if (!row) return null

	const usageUserId = resolveUserStableId(row)
	const entitlement = await resolveUserEntitlementFromRow({
		db: env.APP_DB,
		stableUserId: usageUserId,
		row,
		now,
	})
	const plan = entitlement.plan
	const includedUniqueWorkerDays = resolvePlanLimits(
		plan,
		entitlement.ladder,
		entitlement.creditWallet,
	).maxUniqueWorkerDaysPerMonth
	const currentMonth = utcMonthKey(now)
	const today = utcDayKey(now)
	// Fall through to direct D1 queries when KV is unavailable (some tests
	// construct a partial Env without the binding).
	const rollupCache = env.BUNDLE_ARTIFACTS_KV
		? createKvCachifiedCache(env.BUNDLE_ARTIFACTS_KV)
		: null

	const [monthRows, entitlementConsumption, isOperator, measuredDuration] =
		await Promise.all([
			loadUserMonthRollups({
				db: env.APP_DB,
				cache: rollupCache,
				userId: usageUserId,
				currentMonth,
			}),
			readAdminEntitlementConsumption({
				env,
				usageUserId,
				plan,
				ladder: entitlement.ladder,
				creditWallet: entitlement.creditWallet,
				now,
			}),
			userHasAdminRole(env.APP_DB, usageUserId),
			loadMeasuredDurableObjectDuration({
				db: env.APP_DB,
				userId: usageUserId,
				currentMonth,
			}),
		])

	const monthUsage = toMonthUsage(monthRows, currentMonth)
	const currentMonthUsage =
		monthUsage.find((entry) => entry.month === currentMonth)?.usage ??
		toCompleteUsage([])
	const uniqueWorkerDays =
		currentMonthUsage.find((row) => row.metric === 'dynamic_worker_day')
			?.eventCount ?? 0
	const durableObjectUsage = currentMonthUsage.find(
		(row) => row.metric === 'durable_object_gb_seconds',
	)
	const costVsPay = toAdminCostVsPay({
		uniqueWorkerDays,
		stripePlan: row.stripe_plan,
		stripePriceId: row.stripe_price_id,
		catalog: resolveStripePriceCatalog(env),
		manualPlan: row.plan,
		username: row.username,
		isOperator,
		includedPerAccountMonth: includedUniqueWorkerDays,
	})

	return {
		ok: true,
		stableUserId: usageUserId,
		username: row.username,
		plan,
		currentMonth,
		today,
		currentMonthUsage,
		monthUsage,
		entitlementConsumption,
		warnings: entitlementConsumption.filter((item) => item.overEightyPercent),
		dynamicWorkerCost: toAdminDynamicWorkerCost(
			uniqueWorkerDays,
			includedUniqueWorkerDays,
		),
		durableObjectDuration: {
			...toAdminDurableObjectDuration({
				durationMs: durableObjectUsage?.totalDurationMs ?? 0,
				rpcCount: durableObjectUsage?.eventCount ?? 0,
			}),
			measured: toAdminMeasuredDurableObjectDuration(measuredDuration),
		},
		costVsPay,
	}
}

/**
 * Month-to-date Cloudflare-measured DO active time per class for one user.
 * A missing table (pre-migration test databases) reads as no data.
 */
async function loadMeasuredDurableObjectDuration(input: {
	db: D1Database
	userId: string
	currentMonth: string
}) {
	try {
		const rows = await input.db
			.prepare(
				`SELECT do_class, SUM(active_ms) AS active_ms, MAX(day) AS last_day
				 FROM durable_object_duration_daily
				 WHERE user_id = ? AND day >= ? AND day < ?
				 GROUP BY do_class`,
			)
			.bind(
				input.userId,
				`${input.currentMonth}-01`,
				`${input.currentMonth}-32`,
			)
			.all<{ do_class: string; active_ms: number; last_day: string }>()
		return (rows.results ?? []).map((row) => ({
			doClass: row.do_class,
			activeMs: Number(row.active_ms) || 0,
			lastDay: row.last_day,
		}))
	} catch (error) {
		console.debug('measured-durable-object-duration-read-failed', error)
		return []
	}
}

async function userHasAdminRole(db: D1Database, stableUserId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS present
			 FROM users u
			 INNER JOIN user_roles ur ON ur.user_id = u.id
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE u.stable_user_id = ?
				AND r.name = 'admin'
				AND u.deleting_at IS NULL`,
		)
		.bind(stableUserId)
		.first<{ present: number }>()
	return row != null
}

async function loadUserMonthRollups(input: {
	db: D1Database
	cache: Cache | null
	userId: string
	currentMonth: string
}) {
	if (!input.cache) return await queryUserMonthRollups(input)
	return await cachified({
		// Keyed by the current month so cached history rolls over on UTC
		// month boundaries without waiting for the TTL.
		key: `usage-rollups:user:${input.userId}:asof:${input.currentMonth}`,
		cache: input.cache,
		ttl: rollupCacheTtlMs,
		getFreshValue: () => queryUserMonthRollups(input),
	})
}

async function queryUserMonthRollups(input: {
	db: D1Database
	userId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT user_id, metric, month, event_count, error_count,
				total_duration_ms, total_cpu_ms, total_bytes
			 FROM usage_rollups
			 WHERE user_id = ?
			 ORDER BY month DESC, metric ASC`,
		)
		.bind(input.userId)
		.all<AdminUsageRollupRow>()
	return result.results ?? []
}

function toMonthUsage(
	rows: Array<AdminUsageRollupRow>,
	currentMonth: string,
): Array<AdminUsageMonthRollup> {
	const byMonth = new Map<string, Array<AdminUsageRollupRow>>()
	for (const row of rows) {
		const current = byMonth.get(row.month) ?? []
		current.push(row)
		byMonth.set(row.month, current)
	}
	if (!byMonth.has(currentMonth)) {
		byMonth.set(currentMonth, [])
	}
	return Array.from(byMonth.entries())
		.sort(([left], [right]) => right.localeCompare(left))
		.slice(0, 12)
		.map(([month, usage]) => ({ month, usage: toCompleteUsage(usage) }))
}

function toCompleteUsage(rows: Array<AdminUsageRollupRow>) {
	const byMetric = new Map<string, AdminUsageRollupRow>()
	for (const row of rows) {
		if (isAdminUsageMetric(row.metric)) byMetric.set(row.metric, row)
	}
	return adminUsageMetrics.map((metric) =>
		toUsageRollup(metric, byMetric.get(metric)),
	)
}

function toUsageRollup(
	metric: AdminUsageMetric,
	row: AdminUsageRollupRow | undefined,
): AdminUsageRollup {
	return {
		metric,
		eventCount: Number(row?.event_count ?? 0),
		errorCount: Number(row?.error_count ?? 0),
		totalDurationMs: Number(row?.total_duration_ms ?? 0),
		totalCpuMs: Number(row?.total_cpu_ms ?? 0),
		totalBytes: Number(row?.total_bytes ?? 0),
	}
}

function isAdminUsageMetric(metric: string): metric is AdminUsageMetric {
	return (adminUsageMetrics as ReadonlyArray<string>).includes(metric)
}
