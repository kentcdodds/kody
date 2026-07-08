import { expect, test, vi } from 'vitest'
import {
	aggregateUsageRollups,
	resolveUsageEventsDataset,
	shouldRunUsageAggregationCron,
} from './aggregate-rollups.ts'

type BoundStatement = { sql: string; params: Array<unknown> }

type RollupKeyRow = { user_id: string; metric: string; month: string }

function createFakeDb(input: { existingRollups?: Array<RollupKeyRow> } = {}) {
	const rollups = input.existingRollups?.map((row) => ({ ...row })) ?? []
	const batches: Array<Array<BoundStatement>> = []
	const deletes: Array<BoundStatement> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						sql,
						params,
						async all() {
							if (!sql.includes('SELECT user_id, metric FROM usage_rollups')) {
								throw new Error(`Unsupported all query: ${sql}`)
							}
							return {
								results: rollups
									.filter((row) => row.month === params[0])
									.map((row) => ({
										user_id: row.user_id,
										metric: row.metric,
									})),
							}
						},
						async run() {
							if (!sql.startsWith('DELETE FROM usage_rollups')) {
								throw new Error(`Unsupported run query: ${sql}`)
							}
							deletes.push({ sql, params })
							const month = params[0]
							let changes = 0
							for (let index = 1; index < params.length; index += 2) {
								const rowIndex = rollups.findIndex(
									(row) =>
										row.month === month &&
										row.user_id === params[index] &&
										row.metric === params[index + 1],
								)
								if (rowIndex >= 0) {
									rollups.splice(rowIndex, 1)
									changes += 1
								}
							}
							return { meta: { changes } }
						},
					}
				},
			}
		},
		async batch(statements: Array<BoundStatement>) {
			batches.push(statements)
			return []
		},
	} as unknown as D1Database
	return { db, batches, deletes, rollups }
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
	const { db, batches, deletes } = createFakeDb()

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
	expect(deletes).toHaveLength(0)
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
		deletedRows: 0,
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
	// A hung SQL API must abort instead of stalling the scheduled lane.
	expect(init.signal).toBeInstanceOf(AbortSignal)
	const query = String(init.body)
	expect(query).toContain('FROM kody_usage_events')
	// Half-open month bounds: a lower bound alone would let events stamped
	// into a later month (clock skew, backdated writes) inflate this month.
	expect(query).toContain(`timestamp >= toDateTime('2026-07-01 00:00:00')`)
	expect(query).toContain(`timestamp < toDateTime('2026-08-01 00:00:00')`)
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
		new Date('2026-12-15T10:00:00.000Z'),
	)

	expect(result).toEqual({
		skipped: false,
		month: '2026-12',
		upsertedRows: 0,
		deletedRows: 0,
		users: 0,
	})
	const [url, init] = fetchMock.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	expect(url).toBe(
		'https://cloudflare-mock.local/client/v4/accounts/account-1/analytics_engine/sql',
	)
	const query = String(init.body)
	expect(query).toContain('FROM kody_usage_events_preview')
	// The upper bound rolls over the UTC year boundary.
	expect(query).toContain(`timestamp >= toDateTime('2026-12-01 00:00:00')`)
	expect(query).toContain(`timestamp < toDateTime('2027-01-01 00:00:00')`)
	expect(batches).toHaveLength(0)
})

test('aggregateUsageRollups deletes current-month rows absent from the Analytics Engine result', async () => {
	using _fetchMock = stubFetchResponse({
		body: {
			data: [
				{
					user_id: 'user-a',
					metric: 'execute',
					event_count: 5,
					error_count: 0,
					total_duration_ms: 0,
					total_cpu_ms: 0,
					total_bytes: 0,
				},
			],
		},
	})
	const { db, batches, deletes, rollups } = createFakeDb({
		existingRollups: [
			// Present in the AE result: updated, never deleted.
			{ user_id: 'user-a', metric: 'execute', month: '2026-07' },
			// Absent from the AE result (for example a straggler from a
			// direct D1 upsert whose AE data point was lost): deleted.
			{ user_id: 'user-a', metric: 'job_run', month: '2026-07' },
			{ user_id: 'user-b', metric: 'execute', month: '2026-07' },
			// Other months are never touched, even for stale pairs.
			{ user_id: 'user-a', metric: 'job_run', month: '2026-06' },
		],
	})

	const result = await aggregateUsageRollups(
		createAggregationEnv(db),
		new Date('2026-07-15T10:00:00.000Z'),
	)

	expect(result).toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 1,
		deletedRows: 2,
		users: 1,
	})
	// The present pair went through the upsert batch, not the delete.
	expect(batches[0]?.[0]?.params?.slice(0, 3)).toEqual([
		'user-a',
		'execute',
		'2026-07',
	])
	expect(deletes).toHaveLength(1)
	expect(deletes[0]?.sql).toContain('DELETE FROM usage_rollups WHERE month = ?')
	expect(deletes[0]?.params).toEqual([
		'2026-07',
		'user-a',
		'job_run',
		'user-b',
		'execute',
	])
	expect(rollups).toEqual([
		{ user_id: 'user-a', metric: 'execute', month: '2026-07' },
		{ user_id: 'user-a', metric: 'job_run', month: '2026-06' },
	])
})

test('aggregateUsageRollups chunks stale-row deletes under the bind-parameter cap', async () => {
	using _fetchMock = stubFetchResponse({
		body: {
			data: [
				{
					user_id: 'user-live',
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
	const { db, deletes, rollups } = createFakeDb({
		existingRollups: Array.from({ length: 120 }, (_, index) => ({
			user_id: `stale-user-${index}`,
			metric: 'execute',
			month: '2026-07',
		})),
	})

	const result = await aggregateUsageRollups(
		createAggregationEnv(db),
		new Date('2026-07-15T10:00:00.000Z'),
	)

	expect(result).toMatchObject({ upsertedRows: 1, deletedRows: 120 })
	// 49 pairs per statement: 1 month param + 2 per pair = 99 binds max.
	expect(deletes.map((statement) => statement.params.length)).toEqual([
		99, 99, 45,
	])
	expect(rollups).toEqual([])
})

test('aggregateUsageRollups keeps existing rollups when the Analytics Engine result is empty', async () => {
	// An empty result is more likely ingestion lag or dataset
	// misconfiguration than a real event-free month; the stale-row
	// cleanup must not wipe the month's counters.
	using _fetchMock = stubFetchResponse({ body: { data: [] } })
	const existingRollups = [
		{ user_id: 'user-a', metric: 'execute', month: '2026-07' },
		{ user_id: 'user-b', metric: 'job_run', month: '2026-07' },
	]
	const { db, deletes, rollups } = createFakeDb({ existingRollups })

	const result = await aggregateUsageRollups(
		createAggregationEnv(db),
		new Date('2026-07-15T10:00:00.000Z'),
	)

	expect(result).toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 0,
		deletedRows: 0,
		users: 0,
	})
	expect(deletes).toHaveLength(0)
	expect(rollups).toEqual(existingRollups)
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

test('aggregateUsageRollups surfaces a timed-out Analytics Engine fetch as an error', async () => {
	// AbortSignal.timeout rejects the fetch with a TimeoutError DOMException;
	// it must propagate through the same error path as a failed query.
	const fetchMock = vi.fn(async () => {
		throw new DOMException('The operation timed out.', 'TimeoutError')
	})
	vi.stubGlobal('fetch', fetchMock)
	using _restoreFetch = {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	}
	const { db, batches } = createFakeDb()

	await expect(
		aggregateUsageRollups(
			createAggregationEnv(db),
			new Date('2026-07-15T10:00:00.000Z'),
		),
	).rejects.toThrow('timed out')
	expect(batches).toHaveLength(0)
})
