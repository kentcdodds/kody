import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { type FeatureFlagSuccessMetric } from './registry.ts'
import {
	attachFeatureFlagMetricReadouts,
	loadFeatureFlagSuccessMetricReadout,
	resolveFlagExposuresDataset,
} from './success-metric-readout.ts'
import { type AdminFeatureFlag } from './types.ts'

const successMetric: FeatureFlagSuccessMetric = {
	eventType: 'execute',
	measure: 'error_rate',
	goal: 'decrease',
	hypothesis: 'Fewer execute errors.',
}

const now = new Date('2026-07-15T12:00:00.000Z')

type ExposureRow = { user_id: string; enabled: number; source: string }
type UsageRow = {
	user_id: string
	event_count: number
	error_count: number
	total_duration_ms: number
}

function createReadoutTestDb(input: {
	exposures: Array<ExposureRow>
	usage: Array<UsageRow>
}) {
	const queries: Array<{ query: string; params: Array<unknown> }> = []
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all() {
							queries.push({ query, params })
							if (query.includes('feature_flag_exposure_rollups')) {
								return { results: input.exposures }
							}
							if (query.includes('usage_rollups')) {
								return { results: input.usage }
							}
							throw new Error(`Unsupported query: ${query}`)
						},
					}
				},
			}
		},
	}
	return { db: db as unknown as D1Database, queries }
}

test('D1 readout splits cohorts and excludes override and mixed users', async () => {
	const { db, queries } = createReadoutTestDb({
		exposures: [
			{ user_id: 'user-on', enabled: 1, source: 'rollout' },
			{ user_id: 'user-on-quiet', enabled: 1, source: 'rollout' },
			{ user_id: 'user-off', enabled: 0, source: 'rollout' },
			{ user_id: 'user-override', enabled: 1, source: 'override' },
			{ user_id: 'user-mixed', enabled: 1, source: 'rollout' },
			{ user_id: 'user-mixed', enabled: 0, source: 'rollout' },
		],
		usage: [
			{
				user_id: 'user-on',
				event_count: 10,
				error_count: 2,
				total_duration_ms: 1000,
			},
			{
				user_id: 'user-off',
				event_count: 8,
				error_count: 4,
				total_duration_ms: 400,
			},
			{
				user_id: 'user-override',
				event_count: 100,
				error_count: 0,
				total_duration_ms: 0,
			},
			{
				user_id: 'user-unexposed',
				event_count: 50,
				error_count: 50,
				total_duration_ms: 0,
			},
		],
	})

	const readout = await loadFeatureFlagSuccessMetricReadout(
		{ APP_DB: db },
		{ flagKey: 'metric-test-flag', successMetric },
		now,
	)

	expect(readout).toEqual({
		status: 'ok',
		windowStart: '2026-07-01T00:00:00.000Z',
		windowEnd: '2026-07-15T12:00:00.000Z',
		on: {
			users: 2,
			eventCount: 10,
			errorCount: 2,
			errorRate: 0.2,
			avgDurationMs: 100,
		},
		off: {
			users: 1,
			eventCount: 8,
			errorCount: 4,
			errorRate: 0.5,
			avgDurationMs: 50,
		},
		overrideUsers: 1,
		mixedUsers: 1,
	})
	expect(queries[0]?.params).toEqual([
		'metric-test-flag',
		'2026-07-01',
		'2026-07-15',
	])
	expect(queries[1]?.params).toEqual(['execute', '2026-07'])
})

test('Analytics Engine readout queries both datasets and joins by user', async () => {
	const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
		const query = String((init as { body: string }).body)
		if (query.includes('kody_flag_exposures')) {
			expect(query).toContain("blob2 = 'metric-test-flag'")
			return new Response(
				JSON.stringify({
					data: [
						{
							user_id: 'user-on',
							on_count: 3,
							off_count: 0,
							override_count: 0,
						},
						{
							user_id: 'user-off',
							on_count: 0,
							off_count: 2,
							override_count: 0,
						},
						{
							user_id: 'user-override',
							on_count: 1,
							off_count: 0,
							override_count: 4,
						},
					],
				}),
			)
		}
		expect(query).toContain('kody_usage_events')
		expect(query).toContain("blob2 = 'execute'")
		return new Response(
			JSON.stringify({
				data: [
					{
						user_id: 'user-on',
						event_count: 4,
						error_count: 1,
						total_duration_ms: 800,
					},
					{
						user_id: 'user-off',
						event_count: 5,
						error_count: 5,
						total_duration_ms: 500,
					},
				],
			}),
		)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		const readout = await loadFeatureFlagSuccessMetricReadout(
			{
				APP_DB: {} as D1Database,
				FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
				CLOUDFLARE_ACCOUNT_ID: 'account',
				CLOUDFLARE_API_TOKEN: 'token',
			},
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		)

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(readout).toMatchObject({
			status: 'ok',
			on: { users: 1, eventCount: 4, errorCount: 1, errorRate: 0.25 },
			off: { users: 1, eventCount: 5, errorCount: 5, errorRate: 1 },
			overrideUsers: 1,
			mixedUsers: 0,
		})
	} finally {
		vi.unstubAllGlobals()
	}
})

test('uses the D1 path in local Wrangler dev even with binding and credentials', async () => {
	const { db, queries } = createReadoutTestDb({ exposures: [], usage: [] })
	const readout = await loadFeatureFlagSuccessMetricReadout(
		{
			APP_DB: db,
			FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
			WRANGLER_IS_LOCAL_DEV: 'true',
		},
		{ flagKey: 'metric-test-flag', successMetric },
		now,
	)
	expect(readout).toMatchObject({ status: 'ok' })
	expect(queries).toHaveLength(2)
})

test('reports unavailable when the binding exists but SQL credentials are missing', async () => {
	// Falling back to the empty D1 tables here would present confident zero
	// cohorts even though exposures were written to Analytics Engine.
	const { db, queries } = createReadoutTestDb({ exposures: [], usage: [] })
	const readout = await loadFeatureFlagSuccessMetricReadout(
		{ APP_DB: db, FLAG_EXPOSURES: {} as AnalyticsEngineDataset },
		{ flagKey: 'metric-test-flag', successMetric },
		now,
	)
	expect(readout).toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('credentials'),
	})
	expect(queries).toHaveLength(0)
})

test('degrades to unavailable when the data source fails', async () => {
	silenceExpectedConsoleWarns(['flag-metric-readout-failed'])
	const db = {
		prepare() {
			throw new Error('d1 down')
		},
	} as unknown as D1Database
	const readout = await loadFeatureFlagSuccessMetricReadout(
		{ APP_DB: db },
		{ flagKey: 'metric-test-flag', successMetric },
		now,
	)
	expect(readout).toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('readout query failed'),
	})
})

test('attachFeatureFlagMetricReadouts only decorates measured registry flags', async () => {
	const { db } = createReadoutTestDb({ exposures: [], usage: [] })
	const flags = [
		{
			key: 'metric-test-flag',
			stale: false,
			successMetric,
		},
		{ key: 'demo-indicator', stale: false, successMetric: null },
		{ key: 'retired-flag', stale: true, successMetric: null },
	] as Array<AdminFeatureFlag>

	await attachFeatureFlagMetricReadouts({ APP_DB: db }, flags, now)

	expect(flags[0]?.metricReadout).toMatchObject({ status: 'ok' })
	expect(flags[1]?.metricReadout).toBeUndefined()
	expect(flags[2]?.metricReadout).toBeUndefined()
})

test('resolveFlagExposuresDataset picks the preview dataset in preview', () => {
	expect(resolveFlagExposuresDataset({})).toBe('kody_flag_exposures')
	expect(resolveFlagExposuresDataset({ SENTRY_ENVIRONMENT: 'preview' })).toBe(
		'kody_flag_exposures_preview',
	)
})
