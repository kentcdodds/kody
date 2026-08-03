import { cachified } from '@epic-web/cachified'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { adminUsageMetrics } from '#worker/admin/user-usage-data.ts'
import { queryAnalyticsEngineSql } from '#worker/usage/aggregate-rollups.ts'
import {
	type AdminInsightsActivation,
	type AdminInsightsActivationStep,
	type AdminInsightsAuthCategory,
	type AdminInsightsAuthDay,
	type AdminInsightsEmailDay,
	type AdminInsightsEmailDeliveryDay,
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
type EmailDeliveryDayRow = { day: string; event_type: string; n: number }
type EmailAnalyticsRow = {
	day: string
	event_type: string
	outcome: string
	n: number | string
}
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
type ForkActorRow = { actor: string | null; n: number }
type MilestoneUserRow = { milestone: string; n: number }
type ActivationLatencyRow = { hours: number }

export async function loadAdminInsightsData(
	env: Env,
	now: Date = new Date(),
): Promise<AdminInsightsLoaderData> {
	// Fall through to direct D1 queries when KV is unavailable (some tests
	// construct a partial Env without the binding).
	const cache = env.BUNDLE_ARTIFACTS_KV
		? createKvCachifiedCache(env.BUNDLE_ARTIFACTS_KV)
		: null
	if (!cache) return await queryAdminInsights(env, now)
	return await cachified({
		key: 'admin-insights:v3',
		cache,
		ttl: insightsCacheTtlMs,
		getFreshValue: () => queryAdminInsights(env, now),
	})
}

async function queryAdminInsights(
	env: Env,
	now: Date,
): Promise<AdminInsightsLoaderData> {
	const db = env.APP_DB
	const auditDb = env.AUDIT_DB
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
	const emailInsightsRows = loadEmailInsightsRows({ env, dayCutoff, now })

	const [
		totals,
		jobStats,
		signupRows,
		usersBeforeWindow,
		usageRows,
		emailRows,
		emailDeliveryRows,
		planRows,
		authDayRows,
		authCategoryRows,
		heatmapRows,
		workflowRows,
		activation,
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
		emailInsightsRows.then((rows) => ({ results: rows.emailRows })),
		emailInsightsRows.then((rows) => ({ results: rows.deliveryRows })),
		db
			.prepare(
				`SELECT COALESCE(plan, 'none') AS plan, COUNT(*) AS n
				 FROM users
				 GROUP BY COALESCE(plan, 'none')
				 ORDER BY n DESC`,
			)
			.all<PlanRow>(),
		auditDb
			.prepare(
				`SELECT substr(timestamp, 1, 10) AS day, result, COUNT(*) AS n
				 FROM audit_events
				 WHERE timestamp >= ?
				 GROUP BY day, result`,
			)
			.bind(dayCutoff)
			.all<AuthDayRow>(),
		auditDb
			.prepare(
				`SELECT category, COUNT(*) AS n
				 FROM audit_events
				 WHERE timestamp >= ?
				 GROUP BY category
				 ORDER BY n DESC`,
			)
			.bind(dayCutoff)
			.all<AuthCategoryRow>(),
		auditDb
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
		queryActivation(db),
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
		emailDeliveryByDay: buildEmailDeliveryDays(
			emailDeliveryRows.results ?? [],
			now,
			adminInsightsActivityDays,
		),
		plans: (planRows.results ?? []).map((row): AdminInsightsPlanSlice => ({
			plan: row.plan,
			count: Number(row.n),
		})),
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
		activation,
	}
}

export function resolveEmailEventsDataset(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_email_events_preview'
		: 'kody_email_events'
}

async function loadEmailInsightsRows(input: {
	env: Env
	dayCutoff: string
	now: Date
}): Promise<{
	emailRows: Array<EmailDayRow>
	deliveryRows: Array<EmailDeliveryDayRow>
}> {
	// Wrangler exposes a local Analytics Engine binding, but its SQL API cannot
	// query the emulated dataset. The D1 entitlement_daily_counters mirror is
	// retired, so local/dev email aggregates degrade explicitly to empty rather
	// than consulting a D1 USER graph.
	if (input.env.WRANGLER_IS_LOCAL_DEV === 'true') {
		console.warn('admin-insights-email-quota-aggregate-unavailable', {
			reason: 'entitlement-daily-counters-retired-local-dev',
		})
	}
	if (!input.env.EMAIL_EVENTS) {
		console.warn('admin-insights-email-quota-aggregate-unavailable', {
			reason: 'missing-email-events-binding',
		})
	}
	if (input.env.WRANGLER_IS_LOCAL_DEV === 'true' || !input.env.EMAIL_EVENTS) {
		return { emailRows: [], deliveryRows: [] }
	}

	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) {
		console.warn('admin-insights-email-analytics-unavailable', {
			reason: 'missing-analytics-engine-credentials',
		})
		return { emailRows: [], deliveryRows: [] }
	}
	const nextDay = new Date(input.now.getTime() + dayMs)
		.toISOString()
		.slice(0, 'YYYY-MM-DD'.length)
	const query = `
SELECT
	substring(blob3, 1, 10) AS day,
	blob1 AS event_type,
	blob2 AS outcome,
	sum(_sample_interval) AS n
FROM ${resolveEmailEventsDataset(input.env)}
WHERE blob3 >= '${input.dayCutoff}T00:00:00.000Z'
	AND blob3 < '${nextDay}T00:00:00.000Z'
	AND blob1 IN ('email_send', 'email_receive', 'email_delivery')
GROUP BY day, event_type, outcome
FORMAT JSON
`.trim()
	try {
		const rows = await queryAnalyticsEngineSql<EmailAnalyticsRow>({
			accountId,
			apiToken,
			baseUrl:
				input.env.CLOUDFLARE_API_BASE_URL?.trim() ||
				'https://api.cloudflare.com',
			query,
		})
		const emailRows: Array<EmailDayRow> = []
		const deliveryRows: Array<EmailDeliveryDayRow> = []
		for (const row of rows) {
			const n = Number(row.n)
			if (!Number.isFinite(n)) continue
			if (row.event_type === 'email_send') {
				emailRows.push({
					day: row.day,
					resource: 'email_sends_per_day',
					n,
				})
			} else if (row.event_type === 'email_receive') {
				emailRows.push({
					day: row.day,
					resource: 'email_receives_per_day',
					n,
				})
			} else if (row.event_type === 'email_delivery') {
				deliveryRows.push({
					day: row.day,
					event_type: row.outcome,
					n,
				})
			}
		}
		return { emailRows, deliveryRows }
	} catch (error) {
		// Email reporting is operational context, not an availability
		// dependency for the admin page. Render the rest of the dashboard and
		// zero-fill these charts until Analytics Engine recovers.
		console.warn('admin-insights-email-analytics-unavailable', { error })
		return { emailRows: [], deliveryRows: [] }
	}
}

/**
 * The activation funnel.
 *
 * Signup, verification, agent connection, and forking are all derivable from
 * durable tables, so they are read where they already live rather than
 * duplicated. Only the run-derived steps come from
 * `user_activation_milestones`, because run history is retention-pruned. See
 * `packages/worker/src/usage/activation.ts`.
 */
async function queryActivation(
	db: D1Database,
): Promise<AdminInsightsActivation> {
	const [
		signedUp,
		emailVerified,
		agentConnected,
		packageForked,
		milestoneRows,
		forkActorRows,
		latencyRows,
	] = await Promise.all([
		countQuery(db, `SELECT COUNT(*) AS n FROM users`),
		countQuery(
			db,
			`SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NOT NULL`,
		),
		countQuery(
			db,
			`SELECT COUNT(DISTINCT user_id) AS n FROM mcp_agent_sessions`,
		),
		countQuery(
			db,
			`SELECT COUNT(DISTINCT forker_user_id) AS n FROM community_forks`,
		),
		db
			.prepare(
				`SELECT milestone, COUNT(DISTINCT user_id) AS n
				 FROM user_activation_milestones
				 GROUP BY milestone`,
			)
			.all<MilestoneUserRow>(),
		db
			.prepare(
				`SELECT COALESCE(actor, 'unknown') AS actor, COUNT(*) AS n
				 FROM community_forks
				 GROUP BY COALESCE(actor, 'unknown')`,
			)
			.all<ForkActorRow>(),
		db
			.prepare(
				// julianday() differences are in days; ×24 gives hours. Users
				// who activated before verifying (not expected, but possible
				// for seeded or admin-created accounts) would skew the median
				// negative, so they are excluded rather than clamped.
				`SELECT (julianday(m.reached_at) - julianday(u.email_verified_at)) * 24 AS hours
				 FROM user_activation_milestones AS m
				 JOIN users AS u ON u.id = m.user_id
				 WHERE m.milestone = 'package_activated'
				   AND u.email_verified_at IS NOT NULL
				   AND julianday(m.reached_at) >= julianday(u.email_verified_at)
				 ORDER BY hours ASC`,
			)
			.all<ActivationLatencyRow>(),
	])

	const milestoneUsers = new Map<string, number>()
	for (const row of milestoneRows.results ?? []) {
		milestoneUsers.set(row.milestone, Number(row.n))
	}

	const forksByActor = { human: 0, agent: 0, unknown: 0 }
	for (const row of forkActorRows.results ?? []) {
		if (row.actor === 'human') forksByActor.human += Number(row.n)
		else if (row.actor === 'agent') forksByActor.agent += Number(row.n)
		else forksByActor.unknown += Number(row.n)
	}

	const steps: Array<AdminInsightsActivationStep> = [
		{ step: 'signed_up', users: signedUp },
		{ step: 'email_verified', users: emailVerified },
		{ step: 'agent_connected', users: agentConnected },
		{ step: 'package_forked', users: packageForked },
		{
			step: 'package_run_succeeded',
			users: milestoneUsers.get('package_run_succeeded') ?? 0,
		},
		{
			step: 'package_activated',
			users: milestoneUsers.get('package_activated') ?? 0,
		},
	]

	return {
		steps,
		forksByActor,
		medianHoursToActivation: medianOf(
			(latencyRows.results ?? []).map((row) => Number(row.hours)),
		),
	}
}

/** Median of an ascending list. Even-length lists average the middle pair. */
export function medianOf(sortedValues: Array<number>): number | null {
	const values = sortedValues.filter((value) => Number.isFinite(value))
	if (values.length === 0) return null
	const middle = Math.floor(values.length / 2)
	if (values.length % 2 === 1) return values[middle] ?? null
	const lower = values[middle - 1]
	const upper = values[middle]
	if (lower == null || upper == null) return null
	return (lower + upper) / 2
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
		storedEmailMessages: null,
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

export function buildEmailDeliveryDays(
	rows: Array<EmailDeliveryDayRow>,
	now: Date,
	days: number,
): Array<AdminInsightsEmailDeliveryDay> {
	const byDay = new Map<string, AdminInsightsEmailDeliveryDay>()
	for (const day of listUtcDayKeys(now, days)) {
		byDay.set(day, {
			day,
			delivered: 0,
			deferred: 0,
			bounced: 0,
			failed: 0,
			rejected: 0,
			complained: 0,
		})
	}
	for (const row of rows) {
		const entry = byDay.get(row.day)
		if (!entry) continue
		if (!isEmailDeliveryOutcome(row.event_type)) continue
		entry[row.event_type] += Number(row.n)
	}
	return Array.from(byDay.values())
}

const emailDeliveryOutcomes = [
	'delivered',
	'deferred',
	'bounced',
	'failed',
	'rejected',
	'complained',
] as const

function isEmailDeliveryOutcome(
	value: string,
): value is (typeof emailDeliveryOutcomes)[number] {
	return (emailDeliveryOutcomes as ReadonlyArray<string>).includes(value)
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
