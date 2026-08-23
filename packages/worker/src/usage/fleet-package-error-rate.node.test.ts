import { expect, test } from 'vitest'
import {
	alignToUtcHour,
	buildFleetPackageErrorRateAnalyticsQuery,
	chooseFleetPackageErrorRateElevation,
	countsOf,
	detectFleetPackageErrorRateElevation,
	fleetPackageErrorRateMinDayEvents,
	foldAnalyticsWindowRows,
	parseFleetPackageErrorRateSnapshot,
	toWindowSnapshot,
} from './fleet-package-error-rate.ts'

function windowOf(input: {
	kind: 'hour' | 'day'
	recentEvents: number
	recentErrors: number
	previousEvents: number
	previousErrors: number
}) {
	const recentStart = new Date('2026-08-22T18:00:00.000Z')
	const recentEnd = new Date('2026-08-22T19:00:00.000Z')
	const previousStart = new Date('2026-08-22T17:00:00.000Z')
	return {
		kind: input.kind,
		recent: toWindowSnapshot({
			start: recentStart,
			end: recentEnd,
			byMetric: {
				package_export: countsOf(input.recentEvents, input.recentErrors),
				package_static_call: countsOf(0, 0),
				job_run: countsOf(0, 0),
				workflow_run: countsOf(0, 0),
			},
		}),
		previous: toWindowSnapshot({
			start: previousStart,
			end: recentStart,
			byMetric: {
				package_export: countsOf(input.previousEvents, input.previousErrors),
				package_static_call: countsOf(0, 0),
				job_run: countsOf(0, 0),
				workflow_run: countsOf(0, 0),
			},
		}),
	}
}

test('fleet package error-rate detection stays anonymous and prefers day rises', () => {
	expect(
		detectFleetPackageErrorRateElevation({
			comparison: windowOf({
				kind: 'day',
				recentEvents: 10,
				recentErrors: 10,
				previousEvents: 100,
				previousErrors: 0,
			}),
			minEvents: fleetPackageErrorRateMinDayEvents,
		}),
	).toBeNull()
	expect(
		detectFleetPackageErrorRateElevation({
			comparison: windowOf({
				kind: 'day',
				recentEvents: 100,
				recentErrors: 4,
				previousEvents: 100,
				previousErrors: 1,
			}),
			minEvents: fleetPackageErrorRateMinDayEvents,
		}),
	).toBeNull()
	expect(
		detectFleetPackageErrorRateElevation({
			comparison: windowOf({
				kind: 'day',
				recentEvents: 100,
				recentErrors: 12,
				previousEvents: 100,
				previousErrors: 4,
			}),
			minEvents: fleetPackageErrorRateMinDayEvents,
		}),
	).toMatchObject({ reason: 'absolute_delta', kind: 'day' })
	expect(
		detectFleetPackageErrorRateElevation({
			comparison: windowOf({
				kind: 'day',
				recentEvents: 100,
				recentErrors: 8,
				previousEvents: 100,
				previousErrors: 4,
			}),
			minEvents: fleetPackageErrorRateMinDayEvents,
		}),
	).toMatchObject({ reason: 'relative_factor' })
	expect(
		detectFleetPackageErrorRateElevation({
			comparison: windowOf({
				kind: 'day',
				recentEvents: 80,
				recentErrors: 8,
				previousEvents: 80,
				previousErrors: 0,
			}),
			minEvents: fleetPackageErrorRateMinDayEvents,
		}),
	).toMatchObject({ reason: 'from_zero' })

	expect(
		chooseFleetPackageErrorRateElevation({
			day: windowOf({
				kind: 'day',
				recentEvents: 80,
				recentErrors: 16,
				previousEvents: 80,
				previousErrors: 2,
			}),
			hour: windowOf({
				kind: 'hour',
				recentEvents: 40,
				recentErrors: 20,
				previousEvents: 40,
				previousErrors: 1,
			}),
		})?.kind,
	).toBe('day')

	const query = buildFleetPackageErrorRateAnalyticsQuery({
		dataset: 'kody_usage_events',
		previousStart: new Date('2026-08-21T19:00:00.000Z'),
		recentStart: new Date('2026-08-22T19:00:00.000Z'),
		recentEnd: new Date('2026-08-22T20:00:00.000Z'),
	})
	expect(query).toContain(
		"blob2 IN ('package_export', 'package_static_call', 'job_run', 'workflow_run')",
	)
	expect(query).toContain("toDateTime('2026-08-21 19:00:00')")
	expect(query).not.toContain('blob1')
	expect(query).not.toContain('user_id')
	expect(query).not.toContain('GROUP BY blob1')

	const start = new Date('2026-08-22T18:00:00.000Z')
	const end = new Date('2026-08-22T19:00:00.000Z')
	const snapshot = foldAnalyticsWindowRows(
		[
			{
				window: 'recent',
				metric: 'package_export',
				event_count: 10,
				error_count: 2,
			},
			{
				window: 'previous',
				metric: 'job_run',
				event_count: 5,
				error_count: 1,
			},
		],
		{ window: 'recent', start, end },
	)
	expect(snapshot.combined).toEqual(countsOf(10, 2))
	expect(snapshot.by_metric.find((row) => row.metric === 'job_run')).toEqual({
		metric: 'job_run',
		events: 0,
		errors: 0,
		rate: null,
	})

	expect(parseFleetPackageErrorRateSnapshot({ version: 2 })).toBeNull()
	expect(
		parseFleetPackageErrorRateSnapshot({
			version: 1,
			updatedAt: '2026-08-22T19:00:00.000Z',
			environment: 'production',
			user_id: 'should-not-matter',
		}),
	).toBeNull()
	expect(
		alignToUtcHour(new Date('2026-08-22T19:32:11.123Z')).toISOString(),
	).toBe('2026-08-22T19:00:00.000Z')
})
