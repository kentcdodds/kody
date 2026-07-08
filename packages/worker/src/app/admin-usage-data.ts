import { cachified, type Cache } from '@epic-web/cachified'
import { toHex } from '@kody-internal/shared/hex.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { readPagination, readPositiveInt } from '#app/query-params.ts'
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
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	type AdminUsageDailyCounter,
	type AdminUsageEntitlementConsumption,
	type AdminUsageMetric,
	type AdminUsageLoaderData,
	type AdminUsageMonthRollup,
	type AdminUsageResourceCount,
	type AdminUsageRollup,
	type AdminUsageSelectedUser,
	type AdminUsageUserSummary,
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

export const adminUsageLiveResourceCounts = [
	'saved_packages',
	'scheduled_jobs',
	'package_services',
	'repo_sessions',
	'secrets',
] as const satisfies ReadonlyArray<EntitlementResource>

const adminUsageEntitlementResources = [
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

const adminUsageDailyCounterResources = [
	'email_sends_per_day',
	'email_receives_per_day',
] as const satisfies ReadonlyArray<EntitlementResource>

const defaultPageSize = 20
const maxPageSize = 100
const warningThreshold = 0.8
/**
 * Rollup rows are derived hourly from Analytics Engine in production, so a
 * short KV cache on the per-page read model adds no meaningful staleness
 * while keeping repeated admin page loads off D1.
 */
const rollupCacheTtlMs = 5 * 60 * 1000

type AdminUsageUserRow = {
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

type UserWithUsageId = {
	id: number
	username: string
	email: string
	plan: PlanName | null
	usageUserId: string
}

export async function loadAdminUsageData(
	env: Env,
	requestUrl: string,
	now: Date = new Date(),
): Promise<AdminUsageLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const { page, pageSize, offset } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	const selectedUserId = readPositiveInt(url.searchParams.get('userId'), 0)
	const currentMonth = utcMonthKey(now)
	const today = utcDayKey(now)
	// Fall through to direct D1 queries when KV is unavailable (some tests
	// construct a partial Env without the binding).
	const rollupCache = env.BUNDLE_ARTIFACTS_KV
		? createKvCachifiedCache(env.BUNDLE_ARTIFACTS_KV)
		: null

	const [totalResult, userRows] = await Promise.all([
		env.APP_DB.prepare(`SELECT COUNT(*) AS total FROM users`).first<{
			total: number
		}>(),
		env.APP_DB.prepare(
			`SELECT id, username, email, plan, stable_user_id
			 FROM users
			 ORDER BY id ASC
			 LIMIT ? OFFSET ?`,
		)
			.bind(pageSize, offset)
			.all<AdminUsageUserRow>(),
	])

	const users = await addUsageIds(userRows.results ?? [])
	const selectedUser = await loadSelectedUser({
		db: env.APP_DB,
		users,
		selectedUserId,
	})

	const usageRows = await loadCurrentMonthRollups({
		db: env.APP_DB,
		cache: rollupCache,
		userIds: users.map((user) => user.usageUserId),
		month: currentMonth,
	})
	const usageByUserId = groupRollupsByUserId(usageRows)

	const summaries = await Promise.all(
		users.map((user) =>
			buildUserSummary({
				db: env.APP_DB,
				user,
				usage: usageByUserId.get(user.usageUserId) ?? [],
				now,
			}),
		),
	)

	return {
		ok: true,
		users: summaries,
		selectedUser: selectedUser
			? await buildSelectedUser({
					db: env.APP_DB,
					cache: rollupCache,
					user: selectedUser,
					currentMonth,
					now,
				})
			: null,
		page,
		pageSize,
		total: totalResult?.total ?? 0,
		currentMonth,
		today,
	}
}

async function addUsageIds(
	rows: Array<AdminUsageUserRow>,
): Promise<Array<UserWithUsageId>> {
	return await Promise.all(
		rows.map(async (row) => ({
			id: row.id,
			username: row.username,
			email: row.email,
			plan: parsePlanName(row.plan),
			usageUserId: await resolveUserStableId(row),
		})),
	)
}

async function loadSelectedUser(input: {
	db: D1Database
	users: Array<UserWithUsageId>
	selectedUserId: number
}) {
	if (input.users.length === 0) return null
	if (input.selectedUserId === 0) return input.users[0] ?? null
	const visibleUser = input.users.find(
		(user) => user.id === input.selectedUserId,
	)
	if (visibleUser) return visibleUser

	const row = await input.db
		.prepare(
			`SELECT id, username, email, plan, stable_user_id FROM users WHERE id = ?`,
		)
		.bind(input.selectedUserId)
		.first<AdminUsageUserRow>()
	if (!row) return input.users[0] ?? null
	const [user] = await addUsageIds([row])
	return user ?? null
}

async function buildUserSummary(input: {
	db: D1Database
	user: UserWithUsageId
	usage: Array<AdminUsageRollupRow>
	now: Date
}): Promise<AdminUsageUserSummary> {
	const [todayCounters, resourceCounts] = await Promise.all([
		readDailyCounters(input),
		readResourceCounts(input),
	])
	return {
		id: input.user.id,
		username: input.user.username,
		email: input.user.email,
		plan: input.user.plan,
		currentMonthUsage: toCompleteUsage(input.usage),
		todayCounters,
		resourceCounts,
	}
}

async function buildSelectedUser(input: {
	db: D1Database
	cache: Cache | null
	user: UserWithUsageId
	currentMonth: string
	now: Date
}): Promise<AdminUsageSelectedUser> {
	const [summary, monthRows, entitlementConsumption] = await Promise.all([
		buildUserSummary({
			db: input.db,
			user: input.user,
			usage: await loadCurrentMonthRollups({
				db: input.db,
				cache: input.cache,
				userIds: [input.user.usageUserId],
				month: input.currentMonth,
			}),
			now: input.now,
		}),
		loadUserMonthRollups({
			db: input.db,
			cache: input.cache,
			userId: input.user.usageUserId,
			currentMonth: input.currentMonth,
		}),
		readEntitlementConsumption({
			db: input.db,
			user: input.user,
			now: input.now,
		}),
	])
	const warnings = entitlementConsumption.filter(
		(item) => item.overEightyPercent,
	)
	return {
		...summary,
		monthUsage: toMonthUsage(monthRows, input.currentMonth),
		entitlementConsumption,
		warnings,
	}
}

async function readDailyCounters(input: {
	db: D1Database
	user: UserWithUsageId
	now: Date
}): Promise<Array<AdminUsageDailyCounter>> {
	return await Promise.all(
		adminUsageDailyCounterResources.map(async (resource) => ({
			resource,
			label: entitlementResourceLabels[resource],
			count: await readEntitlementResourceUsage({
				db: input.db,
				userId: input.user.usageUserId,
				resource,
				now: input.now,
			}),
		})),
	)
}

async function readResourceCounts(input: {
	db: D1Database
	user: UserWithUsageId
	now: Date
}): Promise<Array<AdminUsageResourceCount>> {
	return await Promise.all(
		adminUsageLiveResourceCounts.map(async (resource) => ({
			resource,
			label: entitlementResourceLabels[resource],
			current: await readEntitlementResourceUsage({
				db: input.db,
				userId: input.user.usageUserId,
				resource,
				now: input.now,
			}),
		})),
	)
}

async function readEntitlementConsumption(input: {
	db: D1Database
	user: UserWithUsageId
	now: Date
}): Promise<Array<AdminUsageEntitlementConsumption>> {
	return await Promise.all(
		adminUsageEntitlementResources.map(async (resource) => {
			const current = await readEntitlementResourceUsage({
				db: input.db,
				userId: input.user.usageUserId,
				resource,
				now: input.now,
			})
			// Inbound email resources cap plan-less users with deployment
			// fallbacks, so show the effective limit instead of unlimited.
			const limit = isEmailFallbackResource(resource)
				? resolveEmailResourceLimit(input.user.plan, resource)
				: input.user.plan
					? resolvePlanLimit(input.user.plan, resource)
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

async function hashCacheKeyPart(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return toHex(new Uint8Array(digest))
}

async function loadCurrentMonthRollups(input: {
	db: D1Database
	cache: Cache | null
	userIds: Array<string>
	month: string
}) {
	if (input.userIds.length === 0) return []
	if (!input.cache) return await queryCurrentMonthRollups(input)
	// The user id list can be a full admin page (up to 100 ids), so the key
	// carries a digest of the ids rather than the ids themselves.
	const usersKey = await hashCacheKeyPart(input.userIds.join('\n'))
	return await cachified({
		key: `usage-rollups:month:${input.month}:users:${usersKey}`,
		cache: input.cache,
		ttl: rollupCacheTtlMs,
		getFreshValue: () => queryCurrentMonthRollups(input),
	})
}

async function queryCurrentMonthRollups(input: {
	db: D1Database
	userIds: Array<string>
	month: string
}) {
	// The month binding takes one of D1's per-statement parameter slots, so
	// a full 100-user admin page must split the IN list across statements.
	const chunks = chunkArray(input.userIds, maxD1BoundParameters - 1)
	const rows: Array<AdminUsageRollupRow> = []
	for (const chunk of chunks) {
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await input.db
			.prepare(
				`SELECT user_id, metric, month, event_count, error_count,
					total_duration_ms, total_cpu_ms, total_bytes
				 FROM usage_rollups
				 WHERE user_id IN (${placeholders}) AND month = ?`,
			)
			.bind(...chunk, input.month)
			.all<AdminUsageRollupRow>()
		rows.push(...(result.results ?? []))
	}
	return rows
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

function groupRollupsByUserId(rows: Array<AdminUsageRollupRow>) {
	const byUserId = new Map<string, Array<AdminUsageRollupRow>>()
	for (const row of rows) {
		const current = byUserId.get(row.user_id) ?? []
		current.push(row)
		byUserId.set(row.user_id, current)
	}
	return byUserId
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
