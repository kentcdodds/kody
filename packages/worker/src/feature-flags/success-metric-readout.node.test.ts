import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { type FeatureFlagSuccessMetric } from '#universal/feature-flags/registry.ts'
import {
	attachFeatureFlagMetricReadouts,
	loadFeatureFlagSuccessMetricReadout,
	resolveFlagExposuresDataset,
} from './success-metric-readout.ts'
import { type AdminFeatureFlag } from '#universal/feature-flags/types.ts'

const successMetric: FeatureFlagSuccessMetric = {
	eventType: 'execute',
	measure: 'error_rate',
	goal: 'decrease',
	hypothesis: 'Fewer execute errors.',
}

const now = new Date('2026-07-15T12:00:00.000Z')

type ExposureRow = {
	user_id: string
	enabled: number
	source: string
	last_day: string
	last_updated: string | null
}
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

test('D1 readout assigns mixed users by latest fair exposure and surfaces override usage', async () => {
	const { db, queries } = createReadoutTestDb({
		exposures: [
			{
				user_id: 'user-on',
				enabled: 1,
				source: 'rollout',
				last_day: '2026-07-10',
				last_updated: '2026-07-10T00:00:00.000Z',
			},
			{
				user_id: 'user-on-quiet',
				enabled: 1,
				source: 'rollout',
				last_day: '2026-07-10',
				last_updated: '2026-07-10T00:00:00.000Z',
			},
			{
				user_id: 'user-off',
				enabled: 0,
				source: 'rollout',
				last_day: '2026-07-10',
				last_updated: '2026-07-10T00:00:00.000Z',
			},
			{
				user_id: 'user-override',
				enabled: 1,
				source: 'override',
				last_day: '2026-07-12',
				last_updated: '2026-07-12T00:00:00.000Z',
			},
			{
				user_id: 'user-mixed',
				enabled: 0,
				source: 'rollout',
				last_day: '2026-07-05',
				last_updated: '2026-07-05T00:00:00.000Z',
			},
			{
				user_id: 'user-mixed',
				enabled: 1,
				source: 'rollout',
				last_day: '2026-07-12',
				last_updated: '2026-07-12T00:00:00.000Z',
			},
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
				user_id: 'user-mixed',
				event_count: 20,
				error_count: 1,
				total_duration_ms: 200,
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
			users: 3,
			eventCount: 30,
			errorCount: 3,
			errorRate: 0.1,
			avgDurationMs: 40,
		},
		off: {
			users: 1,
			eventCount: 8,
			errorCount: 4,
			errorRate: 0.5,
			avgDurationMs: 50,
		},
		override: {
			users: 1,
			eventCount: 100,
			errorCount: 0,
			errorRate: 0,
			avgDurationMs: 0,
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

test('Analytics Engine readout joins exposures and usage by latest fair state', async () => {
	const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
		const query = String((init as { body: string }).body)
		if (query.includes('kody_flag_exposures')) {
			return new Response(
				JSON.stringify({
					data: [
						{
							user_id: 'user-on',
							state: 'on',
							source: 'global',
							last_ts: '2026-07-10T00:00:00.000Z',
						},
						{
							user_id: 'user-off',
							state: 'off',
							source: 'global',
							last_ts: '2026-07-10T00:00:00.000Z',
						},
						{
							user_id: 'user-override',
							state: 'on',
							source: 'override',
							last_ts: '2026-07-12T00:00:00.000Z',
						},
						{
							user_id: 'user-switched',
							state: 'off',
							source: 'global',
							last_ts: '2026-07-02T00:00:00.000Z',
						},
						{
							user_id: 'user-switched',
							state: 'on',
							source: 'global',
							last_ts: '2026-07-14T00:00:00.000Z',
						},
					],
				}),
			)
		}
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
					{
						user_id: 'user-switched',
						event_count: 6,
						error_count: 0,
						total_duration_ms: 60,
					},
					{
						user_id: 'user-override',
						event_count: 50,
						error_count: 0,
						total_duration_ms: 0,
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
			on: { users: 2, eventCount: 10, errorCount: 1 },
			off: { users: 1, eventCount: 5, errorCount: 5, errorRate: 1 },
			override: { users: 1, eventCount: 50, errorCount: 0 },
			overrideUsers: 1,
			mixedUsers: 1,
		})
		const exposureQuery = String(
			(fetchMock.mock.calls[0]?.[1] as { body: string }).body,
		)
		expect(exposureQuery).toContain('max(blob5) AS last_ts')
		expect(exposureQuery).toContain('GROUP BY blob1, blob3, blob4')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('selects D1 locally, stays unavailable without credentials, and degrades on failure', async () => {
	const local = createReadoutTestDb({ exposures: [], usage: [] })
	await expect(
		loadFeatureFlagSuccessMetricReadout(
			{
				APP_DB: local.db,
				FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
				CLOUDFLARE_ACCOUNT_ID: 'account',
				CLOUDFLARE_API_TOKEN: 'token',
				WRANGLER_IS_LOCAL_DEV: 'true',
			},
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		),
	).resolves.toMatchObject({ status: 'ok' })
	expect(local.queries).toHaveLength(2)

	// Falling back to empty D1 tables would present confident zero cohorts
	// even though exposures were written to Analytics Engine.
	const missingCredentials = createReadoutTestDb({ exposures: [], usage: [] })
	await expect(
		loadFeatureFlagSuccessMetricReadout(
			{
				APP_DB: missingCredentials.db,
				FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
			},
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		),
	).resolves.toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('credentials'),
	})
	expect(missingCredentials.queries).toHaveLength(0)

	silenceExpectedConsoleWarns(['flag-metric-readout-failed'])
	const failingDb = {
		prepare() {
			throw new Error('d1 down')
		},
	} as unknown as D1Database
	await expect(
		loadFeatureFlagSuccessMetricReadout(
			{ APP_DB: failingDb },
			{ flagKey: 'metric-test-flag', successMetric },
			now,
		),
	).resolves.toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('failed'),
	})
})

test('resolveFlagExposuresDataset picks preview vs production table names', () => {
	expect(resolveFlagExposuresDataset({})).toBe('kody_flag_exposures')
	expect(resolveFlagExposuresDataset({ SENTRY_ENVIRONMENT: 'preview' })).toBe(
		'kody_flag_exposures_preview',
	)
})

test('attachFeatureFlagMetricReadouts only fills measured non-stale flags', async () => {
	const { db } = createReadoutTestDb({ exposures: [], usage: [] })
	const flags: Array<AdminFeatureFlag> = [
		{
			key: 'demo-indicator',
			description: null,
			defaultEnabled: false,
			defaultAudience: 'everyone',
			stale: false,
			successMetric,
			global: null,
			overrides: [],
		},
		{
			key: 'demo-indicator',
			description: null,
			defaultEnabled: false,
			defaultAudience: 'everyone',
			stale: false,
			successMetric: null,
			global: null,
			overrides: [],
		},
		{
			key: 'retired-flag',
			description: null,
			defaultEnabled: null,
			defaultAudience: null,
			stale: true,
			successMetric: null,
			global: null,
			overrides: [],
		},
	]
	await attachFeatureFlagMetricReadouts({ APP_DB: db }, flags, now)
	expect(flags[0]?.metricReadout).toMatchObject({ status: 'ok' })
	expect(flags[1]?.metricReadout).toBeUndefined()
	expect(flags[2]?.metricReadout).toBeUndefined()
})
