import { expect, test } from 'vitest'
import { runtimeDurationMetricLabels } from '#client/routes/admin-insights-shared.ts'
import { usageMetricSeries } from './usage-metric-series.ts'

test('usage metric series includes observe-only Dynamic Worker CPU', () => {
	expect(usageMetricSeries.map((entry) => entry.metric)).toEqual([
		'execute',
		'package_export',
		'package_static_call',
		'job_run',
		'workflow_run',
		'outbound_fetch',
		'email_send',
		'email_received',
		'dynamic_worker_day',
		'dynamic_worker_cpu',
		'durable_object_rows_read',
		'durable_object_platform_rows_read',
	])
})

test('usage metric series labels match insights metric labels', () => {
	for (const entry of usageMetricSeries) {
		expect(entry.label).toBe(runtimeDurationMetricLabels[entry.metric])
	}
})
