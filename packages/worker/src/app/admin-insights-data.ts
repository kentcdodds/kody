import { cachified } from '@epic-web/cachified'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { adminUsageMetrics } from '#app/admin-user-usage-data.ts'
import {
	type AdminInsightsAuthCategory,
	type AdminInsightsAuthDay,
	type AdminInsightsEmailDay,
	type AdminInsightsHeatmapCell,
	type AdminInsightsJobHealth,
	type AdminInsightsLoaderData,
	type AdminInsightsPlanSlice,
	type AdminInsightsSignupWeek,
	type AdminInsightsTotals,
	type AdminInsightsUsageMonth,
	type AdminInsightsWorkflowStatus,
	type AdminUsageMetric,
} from './loader-data.ts'

export const adminInsightsSignupWeeks = 12
export const adminInsightsUsageMonths = 12
export const adminInsightsActivityDays = 28

/**
 * The dashboard is a platform-wide read model over many tables, so a short
 * KV cache keeps repeated admin page loads off D1 (same policy as the admin
 * usage rollup reads).
 */
const insightsCacheTtlMs = 5 * 60 * 1000

const dayMs = 24 * 60 * 60 * 1000

type CountRow = { n: number }
type DayCountRow = { day: string; n: number }
type UsageMonthRow = {
	month: string
	metric: string
	events: number
	errors: number
}
type EmailDayRow = { day: string; resource: string; n: number }
type PlanRow = { plan: string; n: number }
type AuthDayRow = { day: string; result: string; n: number }
type AuthCategoryRow = { category: string; n: number }
type HeatmapRow = { day: string; hour: string; n: number }
type WorkflowStatusRow = { status: string | null; n: number }
type JobStatsRow = {
	total: number
	enabled: number | null
	success_runs: number | null
	error_runs: number | null
}

export async function loadAdminInsightsData(
	env: Env,
	now: Date = new Date(),
): Promise<AdminInsightsLoaderData> {
	// Fall through to direct D1 queries when KV is unavailable (some tests
	// construct a partial Env without the binding).
	const cache = env.BUNDLE_ARTIFACTS_KV
		? createKvCachifiedCache(env.BUNDLE_ARTIFACTS_KV)
		: null
	if (!cache) return await queryAdminInsights(env.APP_DB, now)
	return await cachified({
		key: 'admin-insights:v1',
		cache,
		ttl: insightsCacheTtlMs,
		getFreshValue: () => queryAdminInsights(env.APP_DB, now),
	})
}

async function queryAdminInsights(
	db: D1Database,
	now: Date,
): Promise<AdminInsightsLoaderData> {
	const signupCutoff =
		listUtcWeekStarts(now, adminInsightsSignupWeeks)[0] ?? utcDayKey(now)
	const monthCutoff = utcMonthKey(
		new Date(
			Date.UTC(
				now.getUTCFullYear(),
				now.getUTCMonth() - (adminInsightsUsageMonths - 1),
				1,
			),
		),
	)
	const dayCutoff =
		listUtcDayKeys(now, adminInsightsActivityDays)[0] ?? utcDayKey(now)

	const [
		totals,
		jobStats,
		signupRows,
		usersBeforeWindow,
		usageRows,
		emailRows,
		planRows,
		authDayRows,
		authCategoryRows,
		heatmapRows,
		workflowRows,
	] = await Promise.all([
		queryTotals(db),
		db
			.prepare(
				`SELECT COUNT(*) AS total, SUM(enabled) AS enabled,
					SUM(success_count) AS success_runs, SUM(error_count) AS error_runs
				 FROM jobs`,
			)
			.first<JobStatsRow>(),
		db
			.prepare(
				`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
				 FROM users
				 WHERE created_at >= ?
				 GROUP BY day
				 ORDER BY day ASC`,
			)
			.bind(signupCutoff)
			.all<DayCountRow>(),
		db
			.prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at < ?`)
			.bind(signupCutoff)
			.first<CountRow>(),
		db
			.prepare(
				`SELECT month, metric, SUM(event_count) AS events, SUM(error_count) AS errors
				 FROM usage_rollups
				 WHERE month >= ?
				 GROUP BY month, metric
				 ORDER BY month ASC`,
			)
			.bind(monthCutoff)
			.all<UsageMonthRow>(),
		db
			.prepare(
				`SELECT day, resource, SUM(count) AS n
				 FROM entitlement_daily_counters
				 WHERE day >= ? AND resource IN ('email_sends_per_day', 'email_receives_per_day')
				 GROUP BY day, resource`,
			)
			.bind(dayCutoff)
			.all<EmailDayRow>(),
		db
			.prepare(
				`SELECT COALESCE(plan, 'none') AS plan, COUNT(*) AS n
				 FROM users
				 GROUP BY COALESCE(plan, 'none')
				 ORDER BY n DESC`,
			)
			.all<PlanRow>(),
		db
			.prepare(
				`SELECT substr(timestamp, 1, 10) AS day, result, COUNT(*) AS n
				 FROM audit_events
				 WHERE timestamp >= ?
				 GROUP BY day, result`,
			)
			.bind(dayCutoff)
			.all<AuthDayRow>(),
		db
			.prepare(
				`SELECT category, COUNT(*) AS n
				 FROM audit_events
				 WHERE timestamp >= ?
				 GROUP BY category
				 ORDER BY n DESC`,
			)
			.bind(dayCutoff)
			.all<AuthCategoryRow>(),
		db
			.prepare(
				`SELECT substr(timestamp, 1, 10) AS day, substr(timestamp, 12, 2) AS hour, COUNT(*) AS n
				 FROM audit_events
				 WHERE timestamp >= ?
				 GROUP BY day, hour`,
			)
			.bind(dayCutoff)
			.all<HeatmapRow>(),
		db
			.prepare(
				`SELECT COALESCE(status, 'unknown') AS status, COUNT(*) AS n
				 FROM workflow_runs
				 GROUP BY COALESCE(status, 'unknown')
				 ORDER BY n DESC`,
			)
			.all<WorkflowStatusRow>(),
	])

	const jobHealth: AdminInsightsJobHealth = {
		totalJobs: Number(jobStats?.total ?? 0),
		enabledJobs: Number(jobStats?.enabled ?? 0),
		successRuns: Number(jobStats?.success_runs ?? 0),
		errorRuns: Number(jobStats?.error_runs ?? 0),
	}

	return {
		ok: true,
		generatedAt: now.toISOString(),
		totals: {
			...totals,
			scheduledJobs: jobHealth.totalJobs,
			enabledJobs: jobHealth.enabledJobs,
		},
		signupsByWeek: buildSignupWeeks({
			dayRows: signupRows.results ?? [],
			usersBeforeWindow: Number(usersBeforeWindow?.n ?? 0),
			now,
			weeks: adminInsightsSignupWeeks,
		}),
		usageByMonth: buildUsageMonths(
			usageRows.results ?? [],
			now,
			adminInsightsUsageMonths,
		),
		emailByDay: buildEmailDays(
			emailRows.results ?? [],
			now,
			adminInsightsActivityDays,
		),
		plans: (planRows.results ?? []).map(
			(row): AdminInsightsPlanSlice => ({
				plan: row.plan,
				count: Number(row.n),
			}),
		),
		authByDay: buildAuthDays(
			authDayRows.results ?? [],
			now,
			adminInsightsActivityDays,
		),
		authByCategory: (authCategoryRows.results ?? []).map(
			(row): AdminInsightsAuthCategory => ({
				category: row.category,
				count: Number(row.n),
			}),
		),
		authHeatmap: buildHeatmapCells(heatmapRows.results ?? []),
		workflowStatuses: (workflowRows.results ?? []).map(
			(row): AdminInsightsWorkflowStatus => ({
				status: row.status ?? 'unknown',
				count: Number(row.n),
			}),
		),
		jobHealth,
	}
}

async function queryTotals(
	db: D1Database,
): Promise<Omit<AdminInsightsTotals, 'scheduledJobs' | 'enabledJobs'>> {
	const [
		users,
		verifiedUsers,
		savedPackages,
		workflowRuns,
		activeMemories,
		storedEmailMessages,
		secrets,
		activeCommunityListings,
		passkeys,
		oauthConnections,
	] = await Promise.all([
		countQuery(db, `SELECT COUNT(*) AS n FROM users`),
		countQuery(
			db,
			`SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NOT NULL`,
		),
		countQuery(db, `SELECT COUNT(*) AS n FROM saved_packages`),
		countQuery(db, `SELECT COUNT(*) AS n FROM workflow_runs`),
		countQuery(
			db,
			`SELECT COUNT(*) AS n FROM mcp_memories WHERE status = 'active'`,
		),
		countQuery(db, `SELECT COUNT(*) AS n FROM email_messages`),
		countQuery(db, `SELECT COUNT(*) AS n FROM secret_entries`),
		countQuery(
			db,
			`SELECT COUNT(*) AS n FROM community_listings WHERE status = 'active'`,
		),
		countQuery(db, `SELECT COUNT(*) AS n FROM passkeys`),
		countQuery(db, `SELECT COUNT(*) AS n FROM oauth_connections`),
	])
	return {
		users,
		verifiedUsers,
		savedPackages,
		workflowRuns,
		activeMemories,
		storedEmailMessages,
		secrets,
		activeCommunityListings,
		passkeys,
		oauthConnections,
	}
}

async function countQuery(db: D1Database, query: string) {
	const row = await db.prepare(query).first<CountRow>()
	return Number(row?.n ?? 0)
}

/** UTC Monday day key of the week containing the given date. */
export function utcWeekStart(date: Date) {
	const daysSinceMonday = (date.getUTCDay() + 6) % 7
	return utcDayKey(new Date(date.getTime() - daysSinceMonday * dayMs))
}

/** Oldest-first list of UTC Monday keys ending with the week containing now. */
export function listUtcWeekStarts(now: Date, weeks: number) {
	const currentWeekStart = new Date(`${utcWeekStart(now)}T00:00:00Z`)
	const starts: Array<string> = []
	for (let index = weeks - 1; index >= 0; index -= 1) {
		starts.push(
			utcDayKey(new Date(currentWeekStart.getTime() - index * 7 * dayMs)),
		)
	}
	return starts
}

/** Oldest-first list of UTC day keys ending with today. */
export function listUtcDayKeys(now: Date, days: number) {
	const keys: Array<string> = []
	for (let index = days - 1; index >= 0; index -= 1) {
		keys.push(utcDayKey(new Date(now.getTime() - index * dayMs)))
	}
	return keys
}

/** Oldest-first list of UTC month keys ending with the current month. */
export function listUtcMonthKeys(now: Date, months: number) {
	const keys: Array<string> = []
	for (let index = months - 1; index >= 0; index -= 1) {
		keys.push(
			utcMonthKey(
				new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1)),
			),
		)
	}
	return keys
}

export function buildSignupWeeks(input: {
	dayRows: Array<DayCountRow>
	usersBeforeWindow: number
	now: Date
	weeks: number
}): Array<AdminInsightsSignupWeek> {
	const signupsByWeek = new Map<string, number>()
	for (const row of input.dayRows) {
		const week = utcWeekStart(new Date(`${row.day}T00:00:00Z`))
		signupsByWeek.set(week, (signupsByWeek.get(week) ?? 0) + Number(row.n))
	}
	let cumulativeUsers = input.usersBeforeWindow
	return listUtcWeekStarts(input.now, input.weeks).map((weekStart) => {
		const signups = signupsByWeek.get(weekStart) ?? 0
		cumulativeUsers += signups
		return { weekStart, signups, cumulativeUsers }
	})
}

export function buildUsageMonths(
	rows: Array<UsageMonthRow>,
	now: Date,
	months: number,
): Array<AdminInsightsUsageMonth> {
	const byMonth = new Map<string, AdminInsightsUsageMonth>()
	for (const month of listUtcMonthKeys(now, months)) {
		byMonth.set(month, { month, events: emptyMetricEvents(), errorCount: 0 })
	}
	for (const row of rows) {
		const entry = byMonth.get(row.month)
		if (!entry || !isAdminUsageMetric(row.metric)) continue
		entry.events[row.metric] += Number(row.events)
		entry.errorCount += Number(row.errors)
	}
	return Array.from(byMonth.values())
}

export function buildEmailDays(
	rows: Array<EmailDayRow>,
	now: Date,
	days: number,
): Array<AdminInsightsEmailDay> {
	const byDay = new Map<string, AdminInsightsEmailDay>()
	for (const day of listUtcDayKeys(now, days)) {
		byDay.set(day, { day, sends: 0, receives: 0 })
	}
	for (const row of rows) {
		const entry = byDay.get(row.day)
		if (!entry) continue
		if (row.resource === 'email_sends_per_day') entry.sends += Number(row.n)
		if (row.resource === 'email_receives_per_day') {
			entry.receives += Number(row.n)
		}
	}
	return Array.from(byDay.values())
}

export function buildAuthDays(
	rows: Array<AuthDayRow>,
	now: Date,
	days: number,
): Array<AdminInsightsAuthDay> {
	const byDay = new Map<string, AdminInsightsAuthDay>()
	for (const day of listUtcDayKeys(now, days)) {
		byDay.set(day, { day, success: 0, failure: 0, rateLimited: 0 })
	}
	for (const row of rows) {
		const entry = byDay.get(row.day)
		if (!entry) continue
		if (row.result === 'success') entry.success += Number(row.n)
		if (row.result === 'failure') entry.failure += Number(row.n)
		if (row.result === 'rate_limited') entry.rateLimited += Number(row.n)
	}
	return Array.from(byDay.values())
}

export function buildHeatmapCells(
	rows: Array<HeatmapRow>,
): Array<AdminInsightsHeatmapCell> {
	const byCell = new Map<string, AdminInsightsHeatmapCell>()
	for (const row of rows) {
		const hour = Number(row.hour)
		if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue
		const weekday = new Date(`${row.day}T00:00:00Z`).getUTCDay()
		if (!Number.isInteger(weekday)) continue
		const key = `${weekday}:${hour}`
		const cell = byCell.get(key) ?? { weekday, hour, count: 0 }
		cell.count += Number(row.n)
		byCell.set(key, cell)
	}
	return Array.from(byCell.values()).sort(
		(left, right) => left.weekday - right.weekday || left.hour - right.hour,
	)
}

function emptyMetricEvents(): Record<AdminUsageMetric, number> {
	const events = {} as Record<AdminUsageMetric, number>
	for (const metric of adminUsageMetrics) {
		events[metric] = 0
	}
	return events
}

function isAdminUsageMetric(metric: string): metric is AdminUsageMetric {
	return (adminUsageMetrics as ReadonlyArray<string>).includes(metric)
}
