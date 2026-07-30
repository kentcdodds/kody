import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { recordFeatureFlagExposures } from './exposure.ts'

function createAnalyticsDataset() {
	return { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset & {
		writeDataPoint: ReturnType<typeof vi.fn>
	}
}

function createExposureTestDb() {
	const batches: Array<Array<{ query: string; params: Array<unknown> }>> = []
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return { query, params }
				},
			}
		},
		async batch(statements: Array<{ query: string; params: Array<unknown> }>) {
			batches.push(statements)
			return statements.map(() => ({ meta: { changes: 1 } }))
		},
	}
	return { db: db as unknown as D1Database, batches }
}

test('records one Analytics Engine data point per measured flag only', async () => {
	const dataset = createAnalyticsDataset()
	await recordFeatureFlagExposures(
		{ FLAG_EXPOSURES: dataset },
		{
			stableUserId: 'user-1',
			evaluations: {
				// demo-indicator has no successMetric and must be skipped.
				'demo-indicator': { enabled: true, source: 'global' },
				'execute-pre-exec-typecheck': { enabled: true, source: 'rollout' },
			},
			timestamp: '2026-07-15T12:00:00.000Z',
		},
	)
	expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1)
	expect(dataset.writeDataPoint).toHaveBeenCalledWith({
		indexes: ['user-1'],
		blobs: [
			'user-1',
			'execute-pre-exec-typecheck',
			'on',
			'rollout',
			'2026-07-15T12:00:00.000Z',
		],
		doubles: [],
	})
})

test('falls back to D1 exposure rollups without the Analytics Engine binding', async () => {
	const { db, batches } = createExposureTestDb()
	await recordFeatureFlagExposures(
		{ APP_DB: db },
		{
			stableUserId: 'user-2',
			evaluations: {
				'execute-pre-exec-typecheck': { enabled: false, source: 'override' },
			},
			timestamp: '2026-07-15T12:00:00.000Z',
		},
	)
	expect(batches).toHaveLength(1)
	expect(batches[0]).toHaveLength(1)
	expect(batches[0]?.[0]?.query).toContain('feature_flag_exposure_rollups')
	expect(batches[0]?.[0]?.params).toEqual([
		'execute-pre-exec-typecheck',
		'user-2',
		'2026-07-15',
		0,
		'override',
		'2026-07-15T12:00:00.000Z',
	])
})

test('prefers the D1 sink in local Wrangler dev even when the binding exists', async () => {
	const dataset = createAnalyticsDataset()
	const { db, batches } = createExposureTestDb()
	await recordFeatureFlagExposures(
		{ FLAG_EXPOSURES: dataset, APP_DB: db, WRANGLER_IS_LOCAL_DEV: 'true' },
		{
			stableUserId: 'user-local',
			evaluations: {
				'execute-pre-exec-typecheck': { enabled: true, source: 'global' },
			},
			timestamp: '2026-07-15T12:00:00.000Z',
		},
	)
	expect(dataset.writeDataPoint).not.toHaveBeenCalled()
	expect(batches).toHaveLength(1)
})

test('skips recording without a stable user id or measured flags', async () => {
	const dataset = createAnalyticsDataset()
	await recordFeatureFlagExposures(
		{ FLAG_EXPOSURES: dataset },
		{
			stableUserId: '',
			evaluations: {
				'execute-pre-exec-typecheck': { enabled: true, source: 'default' },
			},
		},
	)
	await recordFeatureFlagExposures(
		{ FLAG_EXPOSURES: dataset },
		{
			stableUserId: 'user-3',
			evaluations: {
				'demo-indicator': { enabled: true, source: 'default' },
			},
		},
	)
	expect(dataset.writeDataPoint).not.toHaveBeenCalled()
})

test('never throws when the sink fails', async () => {
	silenceExpectedConsoleWarns([
		'flag-exposure-analytics-failed',
		'flag-exposure-rollup-failed',
	])
	const dataset = createAnalyticsDataset()
	dataset.writeDataPoint.mockImplementation(() => {
		throw new Error('analytics down')
	})
	await expect(
		recordFeatureFlagExposures(
			{ FLAG_EXPOSURES: dataset },
			{
				stableUserId: 'user-4',
				evaluations: {
					'execute-pre-exec-typecheck': { enabled: true, source: 'global' },
				},
			},
		),
	).resolves.toBeUndefined()

	const failingDb = {
		prepare() {
			throw new Error('d1 down')
		},
	} as unknown as D1Database
	await expect(
		recordFeatureFlagExposures(
			{ APP_DB: failingDb },
			{
				stableUserId: 'user-4',
				evaluations: {
					'execute-pre-exec-typecheck': { enabled: true, source: 'global' },
				},
			},
		),
	).resolves.toBeUndefined()
})
