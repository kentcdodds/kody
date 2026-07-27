import { expect, test } from 'vitest'
import {
	filterAccountJobs,
	isActiveAccountJob,
	readJobsViewFilter,
	type FilterableAccountJob,
} from './account-jobs-filter.ts'

const nowMs = Date.parse('2026-07-27T12:00:00.000Z')

function job(
	overrides: Partial<FilterableAccountJob> & Pick<FilterableAccountJob, 'id'>,
): FilterableAccountJob {
	return {
		name: overrides.id,
		ownership: 'ad-hoc',
		scheduleSummary: 'summary',
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		dueNow: false,
		lastRunStatus: null,
		nextRunAt: '2026-07-28T12:00:00.000Z',
		scheduleType: 'cron',
		...overrides,
	}
}

test('isActiveAccountJob keeps enabled jobs and future disabled once jobs', () => {
	expect(
		isActiveAccountJob(
			job({ id: 'enabled-cron', enabled: true, scheduleType: 'cron' }),
			nowMs,
		),
	).toBe(true)
	expect(
		isActiveAccountJob(
			job({
				id: 'future-once',
				enabled: false,
				scheduleType: 'once',
				nextRunAt: '2026-07-28T00:00:00.000Z',
			}),
			nowMs,
		),
	).toBe(true)
	expect(
		isActiveAccountJob(
			job({
				id: 'past-once',
				enabled: false,
				scheduleType: 'once',
				nextRunAt: '2026-07-26T00:00:00.000Z',
			}),
			nowMs,
		),
	).toBe(false)
	expect(
		isActiveAccountJob(
			job({
				id: 'disabled-interval',
				enabled: false,
				scheduleType: 'interval',
				nextRunAt: '2026-07-28T00:00:00.000Z',
			}),
			nowMs,
		),
	).toBe(false)
})

test('readJobsViewFilter defaults to active and accepts history', () => {
	expect(readJobsViewFilter('/account/jobs')).toBe('active')
	expect(readJobsViewFilter('/account/jobs?view=active')).toBe('active')
	expect(readJobsViewFilter('/account/jobs?view=history')).toBe('history')
	expect(readJobsViewFilter('/account/jobs?view=nope')).toBe('active')
})

test('filterAccountJobs defaults to active ops surface and supports history', () => {
	const jobs = [
		job({ id: 'live-cron', name: 'Live digest', enabled: true }),
		job({
			id: 'upcoming-once',
			name: 'Tomorrow ping',
			enabled: false,
			scheduleType: 'once',
			nextRunAt: '2026-07-28T09:00:00.000Z',
		}),
		job({
			id: 'failed-once',
			name: 'Failed ping',
			enabled: false,
			scheduleType: 'once',
			nextRunAt: '2026-07-20T09:00:00.000Z',
		}),
		job({
			id: 'disabled-cron',
			name: 'Old digest',
			enabled: false,
			scheduleType: 'cron',
		}),
	]

	expect(
		filterAccountJobs(jobs, { view: 'active', search: '', nowMs }).map(
			(item) => item.id,
		),
	).toEqual(['live-cron', 'upcoming-once'])

	expect(
		filterAccountJobs(jobs, { view: 'history', search: '', nowMs }).map(
			(item) => item.id,
		),
	).toEqual(['failed-once', 'disabled-cron'])

	expect(
		filterAccountJobs(jobs, {
			view: 'history',
			search: 'failed',
			nowMs,
		}).map((item) => item.id),
	).toEqual(['failed-once'])
})
