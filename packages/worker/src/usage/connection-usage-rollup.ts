/**
 * Hourly Analytics Engine → D1 rollup for `usage_connection_daily`. Recomputes
 * yesterday and today with absolute units, writes only rows that changed,
 * deletes rows Analytics Engine no longer reports for those days, and prunes
 * rows past the retention window. Local/dev writes rows per event in
 * `record-usage.ts` instead.
 */
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	connectionKeyColumns,
	connectionUsageEventTypes,
	isConnectionUsageEventType,
} from '#universal/connection-usage.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import {
	filterLiveUsageRows,
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
	type UsageAggregationEnv,
} from '#worker/usage/aggregate-rollups.ts'

/** Same window as UserMeter daily counters: a full cap week plus history. */
export const connectionUsageRetentionDays = 14

const utcDayMs = 24 * 60 * 60 * 1000
const writeBatchSize = 50

const absoluteUpsertStatement = `
INSERT INTO usage_connection_daily (
	user_id, day, credential_kind, holder_user_id, credential_id,
	package_id, event_type, units, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT (
	user_id, day, credential_kind, holder_user_id, credential_id,
	package_id, event_type
) DO UPDATE SET
	units = excluded.units,
	updated_at = excluded.updated_at
`.trim()

const deleteRowStatement = `
DELETE FROM usage_connection_daily
WHERE user_id = ? AND day = ? AND credential_kind = ? AND holder_user_id = ?
	AND credential_id = ? AND package_id = ? AND event_type = ?
`.trim()

type ConnectionUsageRowKey = {
	user_id: string
	day: string
	credential_kind: string
	holder_user_id: string
	credential_id: string
	package_id: string
	event_type: string
}

type ConnectionUsageRow = ConnectionUsageRowKey & { units: number }

function rowKey(row: ConnectionUsageRowKey) {
	return [
		row.user_id,
		row.day,
		row.credential_kind,
		row.holder_user_id,
		row.credential_id,
		row.package_id,
		row.event_type,
	].join('\0')
}

function bindKey(row: ConnectionUsageRowKey) {
	return [
		row.user_id,
		row.day,
		row.credential_kind,
		row.holder_user_id,
		row.credential_id,
		row.package_id,
		row.event_type,
	]
}

export function connectionUsageRetentionCutoffDay(now: Date) {
	return utcDayKey(
		new Date(now.getTime() - (connectionUsageRetentionDays - 1) * utcDayMs),
	)
}

/**
 * Analytics Engine SQL for connection usage over `[startDay, endDay]`.
 * Counts weight by `_sample_interval`; events without `blob12` group under
 * an empty connection key.
 */
export function buildConnectionUsageDailyQuery(
	dataset: string,
	bounds: { startDay: string; nextDay: string },
) {
	const eventTypes = connectionUsageEventTypes
		.map((eventType) => `'${eventType}'`)
		.join(', ')
	return `
SELECT
	blob1 AS user_id,
	toDate(timestamp) AS day,
	blob12 AS connection_key,
	blob9 AS package_id,
	blob2 AS event_type,
	sum(_sample_interval) AS units
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.startDay} 00:00:00')
	AND timestamp < toDateTime('${bounds.nextDay} 00:00:00')
	AND blob2 IN (${eventTypes})
GROUP BY user_id, day, connection_key, package_id, event_type
FORMAT JSON
`.trim()
}

type ConnectionUsageAnalyticsRow = {
	user_id: string
	day: string
	connection_key: string | null
	package_id: string | null
	event_type: string
	units: number | string
}

export type ConnectionUsageAggregationResult =
	| { skipped: true; reason: string }
	| {
			skipped: false
			upserted: number
			deleted: number
			pruned: number
	  }

export async function aggregateConnectionUsageDaily(
	env: UsageAggregationEnv,
	now: Date = new Date(),
): Promise<ConnectionUsageAggregationResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!env.USAGE_EVENTS || !accountId || !apiToken) {
		return { skipped: true, reason: 'missing-analytics-config' }
	}
	const today = utcDayKey(now)
	const yesterday = utcDayKey(new Date(now.getTime() - utcDayMs))
	const tomorrow = utcDayKey(new Date(now.getTime() + utcDayMs))
	const analyticsRows =
		await queryAnalyticsEngineSql<ConnectionUsageAnalyticsRow>({
			accountId,
			apiToken,
			baseUrl:
				env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com',
			query: buildConnectionUsageDailyQuery(resolveUsageEventsDataset(env), {
				startDay: yesterday,
				nextDay: tomorrow,
			}),
		})
	const liveRows = await filterLiveUsageRows(env.APP_DB, analyticsRows)
	const present = new Map<string, ConnectionUsageRow>()
	for (const row of liveRows) {
		if (!isConnectionUsageEventType(row.event_type)) continue
		const day = String(row.day).slice(0, 'YYYY-MM-DD'.length)
		if (day !== yesterday && day !== today) continue
		const units = Number(row.units)
		if (!Number.isFinite(units) || units <= 0) continue
		const next: ConnectionUsageRow = {
			user_id: row.user_id,
			day,
			...connectionKeyColumns(row.connection_key),
			package_id: (row.package_id ?? '').trim(),
			event_type: row.event_type,
			units,
		}
		const key = rowKey(next)
		const existing = present.get(key)
		present.set(
			key,
			existing ? { ...existing, units: existing.units + units } : next,
		)
	}

	const stored = await runD1WithRetry(() =>
		env.APP_DB.prepare(
			`SELECT user_id, day, credential_kind, holder_user_id, credential_id,
				package_id, event_type, units
			FROM usage_connection_daily
			WHERE day IN (?, ?)`,
		)
			.bind(yesterday, today)
			.all<ConnectionUsageRow>(),
	)
	const storedUnits = new Map<string, number>()
	for (const row of stored.results ?? []) {
		storedUnits.set(rowKey(row), Number(row.units) || 0)
	}

	const updatedAt = now.toISOString()
	const upserts: Array<D1PreparedStatement> = []
	for (const [key, row] of present) {
		if (storedUnits.get(key) === row.units) continue
		upserts.push(
			env.APP_DB.prepare(absoluteUpsertStatement).bind(
				...bindKey(row),
				row.units,
				updatedAt,
			),
		)
	}
	// Analytics Engine ingestion lags, so a missing group is only treated as
	// gone for yesterday, and only when the query returned rows for that day.
	// Today keeps its stored rows until it becomes yesterday.
	const yesterdayReported = [...present.values()].some(
		(row) => row.day === yesterday,
	)
	const deletes: Array<D1PreparedStatement> = []
	if (yesterdayReported) {
		for (const row of stored.results ?? []) {
			if (row.day !== yesterday || present.has(rowKey(row))) continue
			deletes.push(env.APP_DB.prepare(deleteRowStatement).bind(...bindKey(row)))
		}
	}
	const writes = [...upserts, ...deletes]
	for (let index = 0; index < writes.length; index += writeBatchSize) {
		await runD1WithRetry(() =>
			env.APP_DB.batch(writes.slice(index, index + writeBatchSize)),
		)
	}
	const pruned = await runD1WithRetry(() =>
		env.APP_DB.prepare(`DELETE FROM usage_connection_daily WHERE day < ?`)
			.bind(connectionUsageRetentionCutoffDay(now))
			.run(),
	)
	const result = {
		skipped: false as const,
		upserted: upserts.length,
		deleted: deletes.length,
		pruned: Number(pruned.meta.changes ?? 0),
	}
	console.info('connection-usage-aggregation', JSON.stringify(result))
	return result
}
