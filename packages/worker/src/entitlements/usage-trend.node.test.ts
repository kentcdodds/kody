import { expect, test } from 'vitest'
import { toUsageTrendDays } from '#worker/entitlements/usage-trend.ts'

test('toUsageTrendDays pads the retention window and maps counters', () => {
	const days = toUsageTrendDays({
		retentionDays: 3,
		startDay: '2026-10-05',
		endDay: '2026-10-07',
		counters: [
			{
				resource: 'execute_calls_per_day',
				day: '2026-10-05',
				count: 4,
			},
			{
				resource: 'execute_calls_per_day',
				day: '2026-10-06',
				count: 11,
			},
			{
				resource: 'job_runs_per_day',
				day: '2026-10-06',
				count: 2,
			},
			{
				resource: 'automation_invocations_per_day',
				day: '2026-10-07',
				count: 3,
			},
			{
				resource: 'email_sends_per_day',
				day: '2026-10-07',
				count: 9,
			},
		],
		uniqueWorkerDays: [
			{ day: '2026-10-06', count: 2 },
			{ day: '2026-10-07', count: 1 },
		],
	})

	expect(days).toEqual([
		{
			day: '2026-10-05',
			execute: 4,
			uniqueWorkerDays: 0,
			jobRuns: 0,
			automationInvocations: 0,
		},
		{
			day: '2026-10-06',
			execute: 11,
			uniqueWorkerDays: 2,
			jobRuns: 2,
			automationInvocations: 0,
		},
		{
			day: '2026-10-07',
			execute: 0,
			uniqueWorkerDays: 1,
			jobRuns: 0,
			automationInvocations: 3,
		},
	])
})
