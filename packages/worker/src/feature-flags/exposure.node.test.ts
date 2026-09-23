import { expect, test, vi } from 'vitest'
import { recordFeatureFlagExposures } from './exposure.ts'
import { recordPaidRankedSearchFlagExposure } from './paid-ranked-search-exposure.ts'
import { jevSearchRerankFlagKey } from '#universal/feature-flags/registry.ts'

test('skips exposure recording without measured flags or a stable user id', async () => {
	const writeDataPoint = vi.fn()
	const batch = vi.fn()

	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
			APP_DB: { batch } as unknown as D1Database,
		},
		{
			stableUserId: 'user-1',
			evaluations: {
				'demo-indicator': { enabled: true, source: 'global' },
			},
			timestamp: '2026-07-31T00:00:00.000Z',
		},
	)
	expect(writeDataPoint).not.toHaveBeenCalled()
	expect(batch).not.toHaveBeenCalled()

	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			stableUserId: '',
			evaluations: {
				'demo-indicator': { enabled: true, source: 'default' },
			},
		},
	)
	expect(writeDataPoint).not.toHaveBeenCalled()
})

test('evaluation chokepoint skips paid-ranked-search flags; dedicated site records them', async () => {
	const writeDataPoint = vi.fn()
	const evaluations = {
		[jevSearchRerankFlagKey]: { enabled: true, source: 'global' as const },
		'compact-mcp-server-instructions': {
			enabled: true,
			source: 'global' as const,
		},
	}

	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			stableUserId: 'a'.repeat(64),
			evaluations,
			recordingSite: 'evaluation',
			timestamp: '2026-09-20T00:00:00.000Z',
		},
	)
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining(['compact-mcp-server-instructions', 'on']),
	})

	writeDataPoint.mockClear()
	await recordFeatureFlagExposures(
		{
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			stableUserId: 'a'.repeat(64),
			evaluations: {
				[jevSearchRerankFlagKey]: { enabled: true, source: 'global' },
			},
			recordingSite: 'dedicated',
			timestamp: '2026-09-20T00:00:00.000Z',
		},
	)
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining([jevSearchRerankFlagKey, 'on', 'global']),
	})
})

test('recordPaidRankedSearchFlagExposure writes only for paid eligible users', async () => {
	const writeDataPoint = vi.fn()
	const stableUserId = 'b'.repeat(64)
	const prepare = vi.fn((query: string) => {
		if (query.includes('experiments_opt_in')) {
			return {
				bind() {
					return {
						async first() {
							return { experiments_opt_in: 1 }
						},
					}
				},
			}
		}
		if (query.includes('stable_user_id')) {
			return {
				bind() {
					return {
						async first() {
							return { id: 7 }
						},
					}
				},
			}
		}
		if (query.includes('feature_flag_user_overrides')) {
			return {
				bind() {
					return {
						async first() {
							return null
						},
					}
				},
			}
		}
		if (query.includes('FROM feature_flags')) {
			return {
				bind() {
					return {
						async first() {
							return {
								enabled: 1,
								rollout_percent: null,
								audience: 'experiments_opt_in',
							}
						},
					}
				},
			}
		}
		throw new Error(`unexpected query: ${query}`)
	})

	await recordPaidRankedSearchFlagExposure({
		env: {
			APP_DB: { prepare } as unknown as D1Database,
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		stableUserId,
		planEligible: false,
	})
	expect(writeDataPoint).not.toHaveBeenCalled()
	expect(prepare).not.toHaveBeenCalled()

	await recordPaidRankedSearchFlagExposure({
		env: {
			APP_DB: { prepare } as unknown as D1Database,
			FLAG_EXPOSURES: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		stableUserId,
		planEligible: true,
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining([jevSearchRerankFlagKey, 'on', 'global']),
	})
})
