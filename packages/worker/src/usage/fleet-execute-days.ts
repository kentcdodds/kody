/**
 * Fleet-wide UTC-day `execute` counts for the homepage ticker.
 *
 * Production/preview: the hourly `usage_aggregation` lane queries Analytics
 * Engine for the current and previous UTC months and upserts absolute daily
 * totals after the same live-user filter as monthly rollups. An empty month
 * result does not wipe existing days (ingestion lag). A non-empty result is
 * authoritative for that month.
 *
 * Local dev / tests (no `USAGE_EVENTS`): `recordUsage` increments today's
 * row per execute event. This module is a no-op without AE credentials.
 *
 * The public ticker never reads today — only completed UTC days.
 */

import { runD1WithRetry } from '#worker/d1-retry.ts'
import {
	filterLiveUsageRows,
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
	type UsageAggregationEnv,
} from './aggregate-rollups.ts'
import {
	parsePublicCodeRunsWindow,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'

const upsertBatchSize = 50
const deleteStatementDayLimit = 80

const fleetExecuteDayUpsertStatement = `
INSERT INTO fleet_execute_days (day, event_count, updated_at)
VALUES (?1, ?2, ?3)
ON CONFLICT (day) DO UPDATE SET
	event_count = excluded.event_count,
	updated_at = excluded.updated_at
`.trim()

type FleetExecuteDayRow = {
	user_id: string
	day: string
	event_count: number | string
}

export type FleetExecuteDaysSyncResult =
	| { skipped: true; reason: string }
	| {
			skipped: false
			upsertedDays: number
			deletedDays: number
	  }

export async function syncFleetExecuteDays(
	env: UsageAggregationEnv,
	now: Date = new Date(),
): Promise<FleetExecuteDaysSyncResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!env.USAGE_EVENTS || !accountId || !apiToken) {
		console.debug(
			'fleet-execute-days-sync-skipped',
			'missing USAGE_EVENTS binding or Cloudflare REST credentials',
		)
		return { skipped: true, reason: 'missing-analytics-config' }
	}

	const baseUrl =
		env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	const dataset = resolveUsageEventsDataset(env)
	const currentMonth = utcMonthStart(now)
	const priorMonth = utcMonthStart(
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)),
	)
	const [currentRows, previousRows] = await Promise.all([
		queryAnalyticsEngineSql<FleetExecuteDayRow>({
			accountId,
			apiToken,
			baseUrl,
			query: buildMonthExecuteDaysQuery(dataset, utcMonthBounds(now)),
		}),
		queryAnalyticsEngineSql<FleetExecuteDayRow>({
			accountId,
			apiToken,
			baseUrl,
			query: buildMonthExecuteDaysQuery(dataset, utcMonthBounds(priorMonth)),
		}),
	])

	const updatedAt = now.toISOString()
	let upsertedDays = 0
	let deletedDays = 0
	for (const [monthStart, rows] of [
		[currentMonth, currentRows],
		[priorMonth, previousRows],
	] as const) {
		if (rows.length === 0) continue
		const monthPrefix = utcDayString(monthStart).slice(0, 7)
		const liveRows = await filterLiveUsageRows(env.APP_DB, rows)
		const byDay = new Map<string, number>()
		for (const row of liveRows) {
			const day = normalizeUtcDay(row.day)
			if (!day || !day.startsWith(monthPrefix)) continue
			byDay.set(
				day,
				(byDay.get(day) ?? 0) + toNonNegativeCount(row.event_count),
			)
		}
		upsertedDays += await upsertFleetExecuteDays({
			db: env.APP_DB,
			byDay,
			updatedAt,
		})
		deletedDays += await deleteStaleFleetExecuteDays({
			db: env.APP_DB,
			monthStart,
			presentDays: new Set(byDay.keys()),
		})
	}

	const result = {
		skipped: false as const,
		upsertedDays,
		deletedDays,
	}
	console.info('fleet-execute-days-sync', JSON.stringify(result))
	return result
}

export type DelayedExecuteWindowResult =
	| { status: 'ready'; window: PublicCodeRunsWindow }
	| { status: 'empty' }
	| { status: 'failed' }

export async function computeDelayedExecuteWindow(
	db: D1Database,
	now: Date,
): Promise<DelayedExecuteWindowResult> {
	try {
		const oldest = await db
			.prepare(`SELECT MIN(day) AS oldest FROM fleet_execute_days`)
			.first<{ oldest: string | null }>()
		const oldestDay = normalizeUtcDay(oldest?.oldest)
		if (!oldestDay) return { status: 'empty' }

		const today = utcDayString(now)
		const yesterday = addUtcDays(today, -1)
		const dayBeforeYesterday = addUtcDays(today, -2)
		const prefixMonth = oldestDay.slice(0, 7)
		const prefix = await sumExecuteRollupsBeforeMonth(db, prefixMonth)
		const start =
			prefix + (await sumFleetExecuteDaysThrough(db, dayBeforeYesterday))
		const end = prefix + (await sumFleetExecuteDaysThrough(db, yesterday))
		if (start === 0 && end === 0) return { status: 'empty' }
		const window = parsePublicCodeRunsWindow({
			start,
			end,
			updateAt: nextUtcMidnight(now).toISOString(),
		})
		return window ? { status: 'ready', window } : { status: 'failed' }
	} catch (error) {
		console.debug('fleet-execute-days-window-failed', error)
		return { status: 'failed' }
	}
}

async function upsertFleetExecuteDays(input: {
	db: D1Database
	byDay: Map<string, number>
	updatedAt: string
}) {
	const statements = [...input.byDay.entries()].map(([day, eventCount]) =>
		input.db
			.prepare(fleetExecuteDayUpsertStatement)
			.bind(day, eventCount, input.updatedAt),
	)
	for (let index = 0; index < statements.length; index += upsertBatchSize) {
		await runD1WithRetry(() =>
			input.db.batch(statements.slice(index, index + upsertBatchSize)),
		)
	}
	return statements.length
}

async function deleteStaleFleetExecuteDays(input: {
	db: D1Database
	monthStart: Date
	presentDays: ReadonlySet<string>
}) {
	const monthEnd = new Date(
		Date.UTC(
			input.monthStart.getUTCFullYear(),
			input.monthStart.getUTCMonth() + 1,
			1,
		),
	)
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT day FROM fleet_execute_days
				WHERE day >= ?1 AND day < ?2`,
			)
			.bind(utcDayString(input.monthStart), utcDayString(monthEnd))
			.all<{ day: string }>(),
	)
	const staleDays = (results ?? [])
		.map((row) => normalizeUtcDay(row.day))
		.filter((day): day is string => day !== null && !input.presentDays.has(day))
	let deleted = 0
	for (
		let index = 0;
		index < staleDays.length;
		index += deleteStatementDayLimit
	) {
		const chunk = staleDays.slice(index, index + deleteStatementDayLimit)
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await runD1WithRetry(() =>
			input.db
				.prepare(
					`DELETE FROM fleet_execute_days WHERE day IN (${placeholders})`,
				)
				.bind(...chunk)
				.run(),
		)
		deleted += result.meta.changes ?? 0
	}
	return deleted
}

async function sumExecuteRollupsBeforeMonth(db: D1Database, month: string) {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(event_count), 0) AS total
			 FROM usage_rollups
			 WHERE metric = 'execute' AND month < ?1`,
		)
		.bind(month)
		.first<{ total: unknown }>()
	return toNonNegativeCount(row?.total)
}

async function sumFleetExecuteDaysThrough(db: D1Database, day: string) {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(event_count), 0) AS total
			 FROM fleet_execute_days
			 WHERE day <= ?1`,
		)
		.bind(day)
		.first<{ total: unknown }>()
	return toNonNegativeCount(row?.total)
}

function buildMonthExecuteDaysQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	return `
SELECT
	blob1 AS user_id,
	toDate(timestamp) AS day,
	sum(_sample_interval) AS event_count
FROM ${dataset}
WHERE blob2 = 'execute'
	AND timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
GROUP BY blob1, day
FORMAT JSON
`.trim()
}

function utcMonthBounds(now: Date) {
	const toDateTimeArgument = (date: Date) =>
		`${date.toISOString().slice(0, 'YYYY-MM-DD'.length)} 00:00:00`
	return {
		monthStart: toDateTimeArgument(utcMonthStart(now)),
		nextMonthStart: toDateTimeArgument(
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
		),
	}
}

function utcMonthStart(now: Date) {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

function utcDayString(date: Date) {
	return date.toISOString().slice(0, 'YYYY-MM-DD'.length)
}

function addUtcDays(day: string, delta: number) {
	const [year, month, date] = day.split('-').map(Number)
	return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + delta))
		.toISOString()
		.slice(0, 'YYYY-MM-DD'.length)
}

function nextUtcMidnight(now: Date) {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	)
}

function normalizeUtcDay(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const day = value.slice(0, 'YYYY-MM-DD'.length)
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
	return day
}

export function toNonNegativeCount(value: unknown): number {
	if (typeof value === 'bigint') {
		if (value < 0n) return 0
		const parsed = Number(value)
		return Number.isFinite(parsed) ? Math.floor(parsed) : 0
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0) return 0
	return Math.floor(parsed)
}
