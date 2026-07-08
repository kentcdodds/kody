import { expect, test, vi } from 'vitest'
import {
	aggregateUsageRollups,
	resolveUsageEventsDataset,
	shouldRunUsageAggregationCron,
} from './aggregate-rollups.ts'

type BoundStatement = { sql: string; params: Array<unknown> }

function createFakeDb() {
	const batches: Array<Array<BoundStatement>> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					return { sql, params }
				},
			}
		},
		async batch(statements: Array<BoundStatement>) {
			batches.push(statements)
			return []
		},
	} as unknown as D1Database
	return { db, batches }
}

function createAggregationEnv(db: D1Database) {
	return {
		USAGE_EVENTS: { writeDataPoint() {} },
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
	}
}

function stubFetchResponse(input: { status?: number; body: unknown }) {
	const fetchMock = vi.fn(async () => {
		return new Response(
			typeof input.body === 'string' ? input.body : JSON.stringify(input.body),
			{ status: input.status ?? 200 },
		)
	})
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	})
}

test('shouldRunUsageAggregationCron gates to the top of each hour', () => {
	expect(
		shouldRunUsageAggregationCron(new Date('2026-07-05T10:00:30.000Z')),
	).toBe(true)
	expect(
		shouldRunUsageAggregationCron(new Date('2026-07-05T10:30:00.000Z')),
	).toBe(false)
	expect(
		shouldRunUsageAggregationCron(new Date('2026-07-05T10:59:00.000Z')),
	).toBe(false)
})

test('resolveUsageEventsDataset picks the preview dataset only for preview', () => {
	expect(resolveUsageEventsDataset({})).toBe('kody_usage_events')
	expect(resolveUsageEventsDataset({ SENTRY_ENVIRONMENT: 'production' })).toBe(
		'kody_usage_events',
	)
	expect(resolveUsageEventsDataset({ SENTRY_ENVIRONMENT: 'preview' })).toBe(
		'kody_usage_events_preview',
	)
})

test('aggregateUsageRollups no-ops when the binding or credentials are missing', async () => {
	using fetchMock = stubFetchResponse({ body: { data: [] } })
	const { db, batches } = createFakeDb()

	for (const env of [
		{ APP_DB: db },
		{ APP_DB: db, USAGE_EVENTS: { writeDataPoint() {} } },
		{
			APP_DB: db,
			USAGE_EVENTS: { writeDataPoint() {} },
			CLOUDFLARE_ACCOUNT_ID: 'account-1',
		},
		{
			APP_DB: db,
			USAGE_EVENTS: { writeDataPoint() {} },
			CLOUDFLARE_API_TOKEN: 'token-1',
		},
	]) {
		await expect(aggregateUsageRollups(env, new Date())).resolves.toEqual({
			skipped: true,
			reason: 'missing-analytics-config',
		})
	}
	expect(fetchMock).not.toHaveBeenCalled()
	expect(batches).toHaveLength(0)
})

test('aggregateUsageRollups queries Analytics Engine month-to-date and upserts absolute values', async () => {
	using fetchMock = stubFetchResponse({
		body: {
			data: [
				{
					user_id: 'user-a',
					metric: 'execute',
					event_count: 12,
					error_count: 2,
					total_duration_ms: 3456.7,
					total_cpu_ms: 0,
					total_bytes: 1024,
				},
				{
					user_id: 'user-b',
					metric: 'email_send',
					// The SQL API may serialize aggregates as strings.
					event_count: '3',
					error_count: '0',
					total_duration_ms: '0',
					total_cpu_ms: '0',
					total_bytes: '2048',
				},
				// Rows without an owning user or metric are never upserted.
				{
					user_id: '',
					metric: 'execute',
					event_count: 1,
					error_count: 0,
					total_duration_ms: 0,
					total_cpu_ms: 0,
					total_bytes: 0,
				},
			],
		},
	})
	const { db, batches } = createFakeDb()
	const now = new Date('2026-07-15T10:00:00.000Z')

	const result = await aggregateUsageRollups(createAggregationEnv(db), now)

	expect(result).toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 2,
		users: 2,
	})

	expect(fetchMock).toHaveBeenCalledTimes(1)
	const [url, init] = fetchMock.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	expect(url).toBe(
		'https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql',
	)
	expect(init.method).toBe('POST')
	expect((init.headers as Record<string, string>)['authorization']).toBe(
		'Bearer token-1',
	)
	const query = String(init.body)
	expect(query).toContain('FROM kody_usage_events')
	expect(query).toContain(`toDateTime('2026-07-01 00:00:00')`)
	// Sampling-correct aggregates: counts and sums weight by _sample_interval.
	expect(query).toContain('sum(_sample_interval) AS event_count')
	expect(query).toContain(
		`sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count`,
	)
	expect(query).toContain(
		'sum(double1 * _sample_interval) AS total_duration_ms',
	)
	expect(query).toContain('GROUP BY blob1, blob2')

	expect(batches).toHaveLength(1)
	const statements = batches[0] ?? []
	expect(statements).toHaveLength(2)
	expect(statements[0]?.sql).toContain('ON CONFLICT (user_id, metric, month)')
	expect(statements[0]?.sql).toContain('event_count = excluded.event_count')
	expect(statements[0]?.sql).not.toContain('event_count + ')
	expect(statements[0]?.params).toEqual([
		'user-a',
		'execute',
		'2026-07',
		12,
		2,
		3457,
		0,
		1024,
		now.toISOString(),
	])
	expect(statements[1]?.params).toEqual([
		'user-b',
		'email_send',
		'2026-07',
		3,
		0,
		0,
		0,
		2048,
		now.toISOString(),
	])
})

test('aggregateUsageRollups honors CLOUDFLARE_API_BASE_URL and the preview dataset', async () => {
	using fetchMock = stubFetchResponse({ body: { data: [] } })
	const { db, batches } = createFakeDb()

	const result = await aggregateUsageRollups(
		{
			...createAggregationEnv(db),
			CLOUDFLARE_API_BASE_URL: 'https://cloudflare-mock.local/',
			SENTRY_ENVIRONMENT: 'preview',
		},
		new Date('2026-07-15T10:00:00.000Z'),
	)

	expect(result).toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 0,
		users: 0,
	})
	const [url, init] = fetchMock.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	expect(url).toBe(
		'https://cloudflare-mock.local/client/v4/accounts/account-1/analytics_engine/sql',
	)
	expect(String(init.body)).toContain('FROM kody_usage_events_preview')
	expect(batches).toHaveLength(0)
})

test('aggregateUsageRollups batches large result sets and throws on SQL API errors', async () => {
	const manyRows = Array.from({ length: 120 }, (_, index) => ({
		user_id: `user-${index}`,
		metric: 'execute',
		event_count: 1,
		error_count: 0,
		total_duration_ms: 0,
		total_cpu_ms: 0,
		total_bytes: 0,
	}))
	using _manyRowsFetch = stubFetchResponse({ body: { data: manyRows } })
	const { db, batches } = createFakeDb()

	const result = await aggregateUsageRollups(
		createAggregationEnv(db),
		new Date('2026-07-15T10:00:00.000Z'),
	)
	expect(result).toMatchObject({ upsertedRows: 120, users: 120 })
	expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20])

	using _errorFetch = stubFetchResponse({
		status: 400,
		body: 'query error: unknown table',
	})
	await expect(
		aggregateUsageRollups(
			createAggregationEnv(db),
			new Date('2026-07-15T10:00:00.000Z'),
		),
	).rejects.toThrow('Analytics Engine SQL query failed (400)')
})
