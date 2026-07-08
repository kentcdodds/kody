/**
 * Derived usage rollup aggregation.
 *
 * In production/preview, `recordUsage` writes usage events only to Workers
 * Analytics Engine (see `record-usage.ts`); the D1 `usage_rollups` table is a
 * derived aggregate. `aggregateUsageRollups` recomputes the current UTC
 * month's rows from Analytics Engine via the SQL API and upserts them with
 * absolute values — an idempotent recompute, not an increment — so the hourly
 * cron can run any number of times without drift. Analytics Engine retention
 * (~90 days) always covers a full month, so a month-to-date recompute is
 * complete; rows for prior months already in D1 stay untouched.
 *
 * In local dev and tests (no `USAGE_EVENTS` binding or Cloudflare REST
 * credentials) this is a no-op: `recordUsage` upserts `usage_rollups`
 * directly there.
 */

export const usageAggregationCronGateMinutes = 5
export const usageAggregationCronIntervalMinutes = 60

/**
 * Hourly gate for the scheduled handler, mirroring `shouldRunRetentionCron`
 * in `packages/worker/src/app/retention.ts`.
 */
export function shouldRunUsageAggregationCron(now: Date) {
	return (
		now.getUTCMinutes() < usageAggregationCronGateMinutes &&
		now.getUTCMinutes() % usageAggregationCronIntervalMinutes === 0
	)
}

export type UsageAggregationEnv = {
	USAGE_EVENTS?: AnalyticsEngineDataset
	APP_DB: D1Database
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
}

export type UsageAggregationResult =
	| { skipped: true; reason: string }
	| { skipped: false; month: string; upsertedRows: number; users: number }

/**
 * The Analytics Engine SQL API dataset (= table name) written by the
 * `USAGE_EVENTS` binding; see `packages/worker/wrangler.jsonc`.
 */
export function resolveUsageEventsDataset(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_usage_events_preview'
		: 'kody_usage_events'
}

const upsertBatchSize = 50

/**
 * Upper bound for one Analytics Engine SQL API round trip so a hung API can
 * never stall the scheduled lane; a timeout aborts the fetch and surfaces
 * through the same error path as a failed query.
 */
export const analyticsEngineSqlTimeoutMs = 30_000

const usageRollupAbsoluteUpsertStatement = `
INSERT INTO usage_rollups (
	user_id, metric, month,
	event_count, error_count,
	total_duration_ms, total_cpu_ms, total_bytes,
	updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT (user_id, metric, month) DO UPDATE SET
	event_count = excluded.event_count,
	error_count = excluded.error_count,
	total_duration_ms = excluded.total_duration_ms,
	total_cpu_ms = excluded.total_cpu_ms,
	total_bytes = excluded.total_bytes,
	updated_at = excluded.updated_at
`.trim()

/**
 * Half-open [current month start, next month start) UTC bounds for the SQL
 * time filter, formatted for `toDateTime`. The explicit upper bound keeps
 * events stamped into a later month (clock skew, backdated writes) from
 * inflating the current month's rollups.
 */
function utcMonthBounds(now: Date) {
	const toDateTimeArgument = (date: Date) =>
		`${date.toISOString().slice(0, 'YYYY-MM-DD'.length)} 00:00:00`
	return {
		monthStart: toDateTimeArgument(
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
		),
		nextMonthStart: toDateTimeArgument(
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
		),
	}
}

/**
 * Analytics Engine samples data under load, so every aggregate must weight
 * by `_sample_interval`: counts are `sum(_sample_interval)` and value sums
 * are `sum(doubleN * _sample_interval)`. Blob/double positions match the
 * data point layout in `record-usage.ts`.
 */
function buildMonthToDateAggregateQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	return `
SELECT
	blob1 AS user_id,
	blob2 AS metric,
	sum(_sample_interval) AS event_count,
	sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count,
	sum(double1 * _sample_interval) AS total_duration_ms,
	sum(double2 * _sample_interval) AS total_cpu_ms,
	sum(double3 * _sample_interval) AS total_bytes
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
GROUP BY blob1, blob2
FORMAT JSON
`.trim()
}

type AnalyticsEngineSqlRow = {
	user_id: string
	metric: string
	event_count: number | string
	error_count: number | string
	total_duration_ms: number | string
	total_cpu_ms: number | string
	total_bytes: number | string
}

async function queryAnalyticsEngineSql(input: {
	accountId: string
	apiToken: string
	baseUrl: string
	query: string
}): Promise<Array<AnalyticsEngineSqlRow>> {
	const url = `${input.baseUrl.replace(/\/$/, '')}/client/v4/accounts/${input.accountId}/analytics_engine/sql`
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${input.apiToken}`,
		},
		body: input.query,
		signal: AbortSignal.timeout(analyticsEngineSqlTimeoutMs),
	})
	const text = await response.text()
	if (!response.ok) {
		throw new Error(
			`Analytics Engine SQL query failed (${response.status}): ${text.slice(0, 500)}`,
		)
	}
	const parsed = JSON.parse(text) as {
		data?: Array<AnalyticsEngineSqlRow>
	}
	return parsed.data ?? []
}

function toCount(value: number | string) {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

/**
 * Recompute the current UTC month's `usage_rollups` rows from Analytics
 * Engine and upsert them into D1 with absolute values. No-op (with a debug
 * log) when the Analytics Engine binding or the Cloudflare REST credentials
 * are unavailable.
 */
export async function aggregateUsageRollups(
	env: UsageAggregationEnv,
	now: Date = new Date(),
): Promise<UsageAggregationResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!env.USAGE_EVENTS || !accountId || !apiToken) {
		console.debug(
			'usage-rollup-aggregation-skipped',
			'missing USAGE_EVENTS binding or Cloudflare REST credentials',
		)
		return { skipped: true, reason: 'missing-analytics-config' }
	}

	const month = now.toISOString().slice(0, 'YYYY-MM'.length)
	const rows = await queryAnalyticsEngineSql({
		accountId,
		apiToken,
		baseUrl:
			env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com',
		query: buildMonthToDateAggregateQuery(
			resolveUsageEventsDataset(env),
			utcMonthBounds(now),
		),
	})

	const updatedAt = now.toISOString()
	const statements = rows
		.filter((row) => row.user_id && row.metric)
		.map((row) =>
			env.APP_DB.prepare(usageRollupAbsoluteUpsertStatement).bind(
				row.user_id,
				row.metric,
				month,
				toCount(row.event_count),
				toCount(row.error_count),
				toCount(row.total_duration_ms),
				toCount(row.total_cpu_ms),
				toCount(row.total_bytes),
				updatedAt,
			),
		)
	const users = new Set(
		rows.filter((row) => row.user_id && row.metric).map((row) => row.user_id),
	).size
	for (let index = 0; index < statements.length; index += upsertBatchSize) {
		await env.APP_DB.batch(statements.slice(index, index + upsertBatchSize))
	}

	const result = {
		skipped: false as const,
		month,
		upsertedRows: statements.length,
		users,
	}
	console.info('usage-rollup-aggregation', JSON.stringify(result))
	return result
}
