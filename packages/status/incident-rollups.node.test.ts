import { expect, test } from 'vitest'
import { type IncidentSpan } from './day-bars.ts'
import {
	dailyFailedIncrement,
	daysFromFirstSample,
	daysToClearNonIncidentFailures,
	uptimeWindowLabel,
} from './incident-rollups.ts'
import { type ComponentDayStat } from './status-types.ts'

function day(overrides: Partial<ComponentDayStat> = {}): ComponentDayStat {
	return {
		day: '2026-08-19',
		total: 1440,
		failed: 0,
		incidentMinutes: 0,
		...overrides,
	}
}

test('rollups count only incident-state failures and drop empty leading days', () => {
	expect(dailyFailedIncrement(true, 'operational')).toBe(0)
	expect(dailyFailedIncrement(false, 'operational')).toBe(0)
	expect(dailyFailedIncrement(false, 'down')).toBe(1)
	expect(dailyFailedIncrement(true, 'down')).toBe(0)

	const now = Date.parse('2026-08-12T12:00:00.000Z')
	const spans = new Map<string, Array<IncidentSpan>>([
		[
			'package_apps',
			[
				{
					startedAt: Date.parse('2026-08-12T00:20:00.000Z'),
					resolvedAt: Date.parse('2026-08-12T00:26:00.000Z'),
				},
			],
		],
	])
	expect(
		daysToClearNonIncidentFailures(
			[
				{ component: 'app_db', day: '2026-08-12', failed: 2 },
				{ component: 'package_apps', day: '2026-08-12', failed: 6 },
				{ component: 'assets', day: '2026-08-14', failed: 1 },
				{ component: 'kv', day: '2026-08-12', failed: 0 },
			],
			spans,
			now,
		),
	).toEqual([
		{ component: 'app_db', day: '2026-08-12' },
		{ component: 'assets', day: '2026-08-14' },
	])

	const padded = [
		day({ day: '2026-05-22', total: 0 }),
		day({ day: '2026-08-05', total: 1420 }),
		day({ day: '2026-08-19', total: 1417 }),
	]
	expect(daysFromFirstSample(padded).map((entry) => entry.day)).toEqual([
		'2026-08-05',
		'2026-08-19',
	])
	expect(daysFromFirstSample(padded.slice(1))).toEqual(padded.slice(1))
	expect(uptimeWindowLabel(padded)).toBe('2 days')
	expect(uptimeWindowLabel([day({ total: 0 })])).toBe('no data yet')
	expect(
		uptimeWindowLabel(
			Array.from({ length: 90 }, (_, index) =>
				day({ day: `2026-05-${String(index + 1).padStart(2, '0')}` }),
			),
		),
	).toBe('90 days')
})
