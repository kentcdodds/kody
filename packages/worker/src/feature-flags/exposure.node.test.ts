import { expect, test, vi } from 'vitest'
import { recordFeatureFlagExposures } from './exposure.ts'

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
