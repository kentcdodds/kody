/**
 * Daily failed counts follow opened incidents. Isolated ticks below the
 * consecutive-failure threshold stay in the 24h sample log only.
 */

import { incidentMinutesForDay, type IncidentSpan } from './day-bars.ts'
import { type ComponentDayStat } from './status-types.ts'

export const nonIncidentFailuresRetiredMetaKey =
	'non_incident_daily_failures_retired'

export type DailyFailedStat = {
	component: string
	day: string
	failed: number
}

export function dailyFailedIncrement(
	ok: boolean,
	statusAfter: 'operational' | 'down',
): 0 | 1 {
	return !ok && statusAfter === 'down' ? 1 : 0
}

export function daysToClearNonIncidentFailures(
	stats: ReadonlyArray<DailyFailedStat>,
	spansByComponent: ReadonlyMap<string, ReadonlyArray<IncidentSpan>>,
	now: number,
): Array<{ component: string; day: string }> {
	return stats.flatMap((row) => {
		if (row.failed <= 0) return []
		const minutes = incidentMinutesForDay(
			row.day,
			spansByComponent.get(row.component) ?? [],
			now,
		)
		return minutes === 0 ? [{ component: row.component, day: row.day }] : []
	})
}

export function daysFromFirstSample(
	days: ReadonlyArray<ComponentDayStat>,
): Array<ComponentDayStat> {
	const firstData = days.findIndex((day) => day.total > 0)
	if (firstData <= 0) return [...days]
	return days.slice(firstData)
}

export function uptimeWindowLabel(
	days: ReadonlyArray<ComponentDayStat>,
): string {
	const measured = days.filter((day) => day.total > 0).length
	if (measured === 0) return 'no data yet'
	if (measured >= 90) return '90 days'
	return `${measured} days`
}
