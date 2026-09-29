import { expect, test } from 'vitest'
import { usageMetricSeries } from './usage-metric-series.ts'

test('usage metric series includes observe-only Dynamic Worker CPU', () => {
	expect(usageMetricSeries).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				metric: 'dynamic_worker_cpu',
				label: 'Dynamic Worker CPU (Cloudflare-measured)',
			}),
		]),
	)
})
