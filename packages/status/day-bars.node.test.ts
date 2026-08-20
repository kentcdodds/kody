import { expect, test } from 'vitest'
import {
	dayBarClassName,
	dayBarKind,
	dayBarTitle,
	incidentMinutesForDay,
	type IncidentSpan,
} from './day-bars.ts'
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

test('day bars follow opened incidents and keep isolated probe failures green', () => {
	expect(dayBarKind(day({ total: 0 }))).toBe('empty')
	expect(dayBarClassName('empty')).toBe('bar empty')
	expect(dayBarTitle(day({ total: 0 }))).toBe('2026-08-19: no data')

	expect(dayBarKind(day())).toBe('ok')
	expect(dayBarTitle(day())).toBe('2026-08-19: 100% up')

	const isolated = day({ failed: 2 })
	expect(dayBarKind(isolated)).toBe('ok')
	expect(dayBarClassName('ok')).toBe('bar')
	expect(dayBarTitle(isolated)).toBe(
		'2026-08-19: 2 isolated probe failures, no incident',
	)
	expect(dayBarTitle(day({ failed: 1 }))).toBe(
		'2026-08-19: 1 isolated probe failure, no incident',
	)

	const shortIncident = day({ failed: 6, incidentMinutes: 6 })
	expect(dayBarKind(shortIncident)).toBe('partial')
	expect(dayBarClassName('partial')).toBe('bar partial')
	expect(dayBarTitle(shortIncident)).toBe(
		'2026-08-19: 6 min incident · 99.58% up',
	)

	const longIncident = day({ failed: 90, incidentMinutes: 90 })
	expect(dayBarKind(longIncident)).toBe('bad')
	expect(dayBarClassName('bad')).toBe('bar bad')
	expect(dayBarTitle(longIncident)).toBe(
		'2026-08-19: 90 min incident · 93.75% up',
	)

	const highFailedRatio = day({ failed: 80, incidentMinutes: 20 })
	expect(dayBarKind(highFailedRatio)).toBe('bad')

	const midnight = Date.parse('2026-08-12T00:00:00.000Z')
	const now = Date.parse('2026-08-12T12:00:00.000Z')
	const crossing: IncidentSpan = {
		startedAt: Date.parse('2026-08-11T23:58:00.000Z'),
		resolvedAt: Date.parse('2026-08-12T00:03:00.000Z'),
	}
	expect(incidentMinutesForDay('2026-08-11', [crossing], now)).toBe(2)
	expect(incidentMinutesForDay('2026-08-12', [crossing], now)).toBe(3)
	expect(incidentMinutesForDay('2026-08-13', [crossing], now)).toBe(0)
	expect(
		incidentMinutesForDay(
			'2026-08-12',
			[{ startedAt: midnight, resolvedAt: null }],
			now,
		),
	).toBe(720)
	expect(incidentMinutesForDay('not-a-day', [crossing], now)).toBe(0)

	const underHour = incidentMinutesForDay(
		'2026-08-12',
		[
			{
				startedAt: midnight,
				resolvedAt: midnight + 59 * 60_000 + 30_000,
			},
		],
		now,
	)
	expect(underHour).toBe(59)
	expect(dayBarKind(day({ failed: 59, incidentMinutes: underHour }))).toBe(
		'partial',
	)
})
