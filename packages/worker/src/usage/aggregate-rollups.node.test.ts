import { expect, test, vi } from 'vitest'
import {
	aggregateUsageRollups,
	analyticsEngineSqlRetryMaxAttempts,
	isRetryableAnalyticsEngineSqlStatus,
	resolveUsageEventsDataset,
	shouldRunUsageAggregationCron,
} from './aggregate-rollups.ts'

type BoundStatement = { sql: string; params: Array<unknown> }

type RollupKeyRow = { user_id: string; metric: string; month: string }
type EmailUsageRow = {
	user_id: string
	metric: string
	month: string
	event_count: number
	error_count: number
	total_duration_ms: number
	total_cpu_ms: number
	total_bytes: number
}

function createFakeDb(
	input: {
		existingRollups?: Array<RollupKeyRow>
		emailUsageRows?: Array<EmailUsageRow>
		liveUserIds?: Array<string>
	} = {},
) {
	const rollups = input.existingRollups?.map((row) => ({ ...row })) ?? []
	const batches: Array<Array<BoundStatement>> = []
	const deletes: Array<BoundStatement> = []
	const selects: Array<BoundStatement> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						sql,
						params,
						async all() {
							if (sql.includes('SELECT stable_user_id FROM users')) {
								const allowed = new Set(input.liveUserIds ?? params.map(String))
								return {
									results: params
										.map(String)
										.filter((userId) => allowed.has(userId))
										.map((stable_user_id) => ({ stable_user_id })),
								}
							}
							if (sql.includes('FROM email_delivery_events event')) {
								selects.push({ sql, params })
								return { results: input.emailUsageRows ?? [] }
							}
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
							if (sql.startsWith('UPDATE email_delivery_events')) {
								return { meta: { changes: 0 } }
							}
							if (!sql.startsWith('DELETE FROM usage_rollups')) {
								throw new Error(`Unsupported run query: ${sql}`)
							}
							deletes.push({ sql, params })
							if (sql.includes('NOT EXISTS')) {
								const months = new Set(params.slice(0, 2))
								const live = new Set(input.liveUserIds ?? [])
								let changes = 0
								for (let index = rollups.length - 1; index >= 0; index -= 1) {
									const row = rollups[index]
									if (
										row &&
										months.has(row.month) &&
										row.user_id !== 'system:email' &&
										input.liveUserIds != null &&
										!live.has(row.user_id)
									) {
										rollups.splice(index, 1)
										changes += 1
									}
								}
								return { meta: { changes } }
							}
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
	return { db, batches, deletes, selects, rollups }
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
	let callIndex = 0
	const fetchMock = vi.fn(async () => {
		const isFirst = callIndex === 0
		callIndex += 1
		const body = isFirst ? input.body : { data: [] }
		return new Response(
			typeof body === 'string' ? body : JSON.stringify(body),
			{ status: isFirst ? (input.status ?? 200) : 200 },
		)
	})
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	})
}

function stubFetchSequence(bodies: Array<unknown>) {
	let index = 0
	const fetchMock = vi.fn(async () => {
		const body = bodies[index] ?? bodies.at(-1) ?? { data: [] }
		index += 1
		return new Response(
			typeof body === 'string' ? body : JSON.stringify(body),
			{ status: 200 },
		)
	})
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	})
}

function stubFetchStatusSequence(
	responses: Array<{ status: number; body: unknown }>,
) {
	let index = 0
	const fetchMock = vi.fn(async () => {
		const next = responses[index] ??
			responses.at(-1) ?? {
				status: 200,
				body: { data: [] },
			}
		index += 1
		return new Response(
			typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
			{ status: next.status },
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

test('aggregateUsageRollups merges current and previous Analytics months with durable inbound usage', async () => {
	using fetchMock = stubFetchSequence([
		{
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
		{
			data: [
				{
					user_id: 'user-c',
					metric: 'email_received',
					event_count: 5,
					error_count: 2,
					total_duration_ms: 100,
					total_cpu_ms: 0,
					total_bytes: 1000,
				},
			],
		},
	])
	const { db, batches, selects } = createFakeDb({
		emailUsageRows: [
			{
				user_id: 'user-a',
				metric: 'email_received',
				month: '2026-07',
				event_count: 2,
				error_count: 0,
				total_duration_ms: 50,
				total_cpu_ms: 0,
				total_bytes: 4096,
			},
			{
				user_id: 'user-c',
				metric: 'email_received',
				month: '2026-06',
				event_count: 1,
				error_count: 0,
				total_duration_ms: 25,
				total_cpu_ms: 0,
				total_bytes: 512,
			},
		],
	})
	const now = new Date('2026-07-01T00:00:30.000Z')

	const result = await aggregateUsageRollups(createAggregationEnv(db), now)

	expect(result).toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 4,
		deletedRows: 0,
		users: 3,
	})

	expect(fetchMock).toHaveBeenCalledTimes(2)
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
	const previousQuery = String(
		(fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body,
	)
	expect(previousQuery).toContain(
		`timestamp >= toDateTime('2026-06-01 00:00:00')`,
	)
	expect(previousQuery).toContain(
		`timestamp < toDateTime('2026-07-01 00:00:00')`,
	)
	// Sampling-correct aggregates: counts and sums weight by _sample_interval.
	expect(query).toContain('sum(_sample_interval) AS event_count')
	expect(query).toContain(
		`sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count`,
	)
	expect(query).toContain(
		'sum(double1 * _sample_interval) AS total_duration_ms',
	)
	expect(query).toContain('GROUP BY blob1, blob2')
	expect(selects[0]?.sql).not.toContain('JOIN email_messages')
	expect(selects[0]?.sql).toContain(`'$.usageMonth'`)
	expect(selects[0]?.sql).toContain(`'$.usageBytes'`)
	expect(selects[0]?.params).toEqual(['2026-07', '2026-06'])

	expect(batches).toHaveLength(1)
	const statements = batches[0] ?? []
	expect(statements).toHaveLength(4)
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
	expect(statements[2]?.params).toEqual([
		'user-c',
		'email_received',
		'2026-06',
		6,
		2,
		125,
		0,
		1512,
		now.toISOString(),
	])
	expect(statements[3]?.params).toEqual([
		'user-a',
		'email_received',
		'2026-07',
		2,
		0,
		50,
		0,
		4096,
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

test('hourly aggregation cannot recreate rollups for deleting or deleted users', async () => {
	using _fetchMock = stubFetchSequence([
		{
			data: ['user-live', 'user-deleting', 'user-deleted'].map((user_id) => ({
				user_id,
				metric: 'execute',
				event_count: 1,
				error_count: 0,
				total_duration_ms: 0,
				total_cpu_ms: 0,
				total_bytes: 0,
			})),
		},
		{ data: [] },
	])
	const { db, batches, rollups } = createFakeDb({
		liveUserIds: ['user-live'],
		existingRollups: [
			{ user_id: 'user-deleting', metric: 'execute', month: '2026-07' },
			{ user_id: 'user-deleted', metric: 'execute', month: '2026-07' },
		],
		emailUsageRows: [
			{
				user_id: 'user-deleting',
				metric: 'email_received',
				month: '2026-07',
				event_count: 1,
				error_count: 0,
				total_duration_ms: 1,
				total_cpu_ms: 0,
				total_bytes: 10,
			},
		],
	})

	const result = await aggregateUsageRollups(
		createAggregationEnv(db),
		new Date('2026-07-15T10:00:00.000Z'),
	)
	expect(result).toMatchObject({
		upsertedRows: 1,
		deletedRows: 2,
		users: 1,
	})
	expect(batches[0]?.map((statement) => statement.params[0])).toEqual([
		'user-live',
	])
	expect(rollups).toEqual([])
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
	const staleDeletes = deletes.filter(
		(statement) => !statement.sql.includes(`user_id != 'system:email'`),
	)
	expect(staleDeletes).toHaveLength(1)
	expect(staleDeletes[0]?.sql).toContain(
		'DELETE FROM usage_rollups WHERE month = ?',
	)
	expect(staleDeletes[0]?.params).toEqual([
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
	expect(
		deletes
			.filter(
				(statement) => !statement.sql.includes(`user_id != 'system:email'`),
			)
			.map((statement) => statement.params.length),
	).toEqual([99, 99, 45])
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
	const { db, batches, deletes, rollups } = createFakeDb({
		existingRollups,
		emailUsageRows: [
			{
				user_id: 'user-a',
				metric: 'email_received',
				month: '2026-07',
				event_count: 1,
				error_count: 0,
				total_duration_ms: 10,
				total_cpu_ms: 0,
				total_bytes: 128,
			},
		],
	})

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
	expect(
		deletes.filter(
			(statement) => !statement.sql.includes(`user_id != 'system:email'`),
		),
	).toHaveLength(0)
	expect(batches).toHaveLength(0)
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

test('isRetryableAnalyticsEngineSqlStatus covers transient Cloudflare statuses', () => {
	expect(isRetryableAnalyticsEngineSqlStatus(429)).toBe(true)
	expect(isRetryableAnalyticsEngineSqlStatus(500)).toBe(true)
	expect(isRetryableAnalyticsEngineSqlStatus(502)).toBe(true)
	expect(isRetryableAnalyticsEngineSqlStatus(503)).toBe(true)
	expect(isRetryableAnalyticsEngineSqlStatus(400)).toBe(false)
	expect(isRetryableAnalyticsEngineSqlStatus(401)).toBe(false)
	expect(isRetryableAnalyticsEngineSqlStatus(404)).toBe(false)
})

test('aggregateUsageRollups retries Analytics Engine SQL 500 then succeeds', async () => {
	using fetchMock = stubFetchStatusSequence([
		{ status: 500, body: 'Internal server error' },
		{ status: 200, body: { data: [] } },
		{ status: 200, body: { data: [] } },
	])
	const { db, batches } = createFakeDb()

	await expect(
		aggregateUsageRollups(
			createAggregationEnv(db),
			new Date('2026-07-15T10:00:00.000Z'),
		),
	).resolves.toMatchObject({ skipped: false, upsertedRows: 0 })
	expect(fetchMock).toHaveBeenCalledTimes(3)
	expect(batches).toHaveLength(0)
})

test('aggregateUsageRollups exhausts retries on persistent Analytics Engine 500', async () => {
	using fetchMock = stubFetchStatusSequence([
		{ status: 500, body: 'Internal server error' },
		{ status: 500, body: 'Internal server error' },
		{ status: 500, body: 'Internal server error' },
	])
	const { db, batches } = createFakeDb()

	await expect(
		aggregateUsageRollups(
			createAggregationEnv(db),
			new Date('2026-07-15T10:00:00.000Z'),
		),
	).rejects.toThrow('Analytics Engine SQL query failed (500)')
	expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(
		analyticsEngineSqlRetryMaxAttempts,
	)
	expect(batches).toHaveLength(0)
})

test('aggregateUsageRollups does not retry Analytics Engine SQL 400', async () => {
	using fetchMock = stubFetchStatusSequence([
		{ status: 400, body: 'query error: unknown table' },
	])
	const { db, batches } = createFakeDb()

	await expect(
		aggregateUsageRollups(
			createAggregationEnv(db),
			new Date('2026-07-15T10:00:00.000Z'),
		),
	).rejects.toThrow('Analytics Engine SQL query failed (400)')
	// Both month queries may start in parallel, but neither retries a 400.
	expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2)
	expect(batches).toHaveLength(0)
})
