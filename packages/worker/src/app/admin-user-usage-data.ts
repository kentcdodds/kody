import { cachified, type Cache } from '@epic-web/cachified'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	entitlementResourceLabels,
	isEmailFallbackResource,
	parsePlanName,
	resolveEmailResourceLimit,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { readEntitlementResourceUsage } from '#worker/entitlements/service.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	type AdminUsageEntitlementConsumption,
	type AdminUsageMetric,
	type AdminUsageMonthRollup,
	type AdminUsageRollup,
	type AdminUserUsageLoaderData,
} from './loader-data.ts'

export const adminUsageMetrics = [
	'execute',
	'package_export',
	'job_run',
	'workflow_run',
	'service_runtime',
	'outbound_fetch',
	'email_send',
	'email_received',
] as const satisfies ReadonlyArray<AdminUsageMetric>

const adminUserUsageEntitlementResources = [
	'saved_packages',
	'scheduled_jobs',
	'package_services',
	'persistent_package_services',
	'repo_sessions',
	'email_sends_per_day',
	'email_receives_per_day',
	'stored_email_messages',
	'secrets',
	'concurrent_workflows',
] as const satisfies ReadonlyArray<EntitlementResource>

const warningThreshold = 0.8
/**
 * Rollup rows are derived hourly from Analytics Engine in production, so a
 * short KV cache on the per-user read model adds no meaningful staleness
 * while keeping repeated admin drill-down loads off D1.
 */
const rollupCacheTtlMs = 5 * 60 * 1000

type AdminUserUsageUserRow = {
	id: number
	username: string
	email: string
	plan: string | null
	stable_user_id?: string | null
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
	userId: number,
	now: Date = new Date(),
): Promise<AdminUserUsageLoaderData | null> {
	const row = await env.APP_DB.prepare(
		`SELECT id, username, email, plan, stable_user_id FROM users WHERE id = ?`,
	)
		.bind(userId)
		.first<AdminUserUsageUserRow>()
	if (!row) return null

	const plan = parsePlanName(row.plan)
	const usageUserId = await resolveUserStableId(row)
	const currentMonth = utcMonthKey(now)
	const today = utcDayKey(now)
	// Fall through to direct D1 queries when KV is unavailable (some tests
	// construct a partial Env without the binding).
	const rollupCache = env.BUNDLE_ARTIFACTS_KV
		? createKvCachifiedCache(env.BUNDLE_ARTIFACTS_KV)
		: null

	const [monthRows, entitlementConsumption] = await Promise.all([
		loadUserMonthRollups({
			db: env.APP_DB,
			cache: rollupCache,
			userId: usageUserId,
			currentMonth,
		}),
		readEntitlementConsumption({
			db: env.APP_DB,
			usageUserId,
			plan,
			now,
		}),
	])

	const monthUsage = toMonthUsage(monthRows, currentMonth)
	const currentMonthUsage =
		monthUsage.find((entry) => entry.month === currentMonth)?.usage ??
		toCompleteUsage([])

	return {
		ok: true,
		userId: row.id,
		username: row.username,
		plan,
		currentMonth,
		today,
		currentMonthUsage,
		monthUsage,
		entitlementConsumption,
		warnings: entitlementConsumption.filter((item) => item.overEightyPercent),
	}
}

async function readEntitlementConsumption(input: {
	db: D1Database
	usageUserId: string
	plan: PlanName | null
	now: Date
}): Promise<Array<AdminUsageEntitlementConsumption>> {
	return await Promise.all(
		adminUserUsageEntitlementResources.map(async (resource) => {
			const current = await readEntitlementResourceUsage({
				db: input.db,
				userId: input.usageUserId,
				resource,
				now: input.now,
			})
			// Inbound email resources cap plan-less users with deployment
			// fallbacks, so show the effective limit instead of unlimited.
			const limit = isEmailFallbackResource(resource)
				? resolveEmailResourceLimit(input.plan, resource)
				: input.plan
					? resolvePlanLimit(input.plan, resource)
					: null
			const percentOfLimit =
				limit == null || limit === 0 ? null : current / limit
			return {
				resource,
				label: entitlementResourceLabels[resource],
				current,
				limit,
				percentOfLimit,
				overEightyPercent:
					percentOfLimit !== null && percentOfLimit > warningThreshold,
			}
		}),
	)
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
