import { expect, test } from 'vitest'
import {
	filterAccountJobs,
	isActiveAccountJob,
	readJobsOwnershipFilter,
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

test('account jobs filters cover active/history views and ownership', () => {
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

	expect(readJobsViewFilter('/account/jobs')).toBe('active')
	expect(readJobsViewFilter('/account/jobs?view=history')).toBe('history')
	expect(readJobsViewFilter('/account/jobs?view=all')).toBe('all')
	expect(readJobsViewFilter('/account/jobs?view=nope')).toBe('active')

	expect(readJobsOwnershipFilter('/account/jobs')).toBe('all')
	expect(readJobsOwnershipFilter('/account/jobs?ownership=package')).toBe(
		'package',
	)
	expect(readJobsOwnershipFilter('/account/jobs?ownership=ad-hoc')).toBe(
		'ad-hoc',
	)
	expect(readJobsOwnershipFilter('/account/jobs?ownership=nope')).toBe('all')

	const jobs = [
		job({
			id: 'live-cron',
			name: 'Live digest',
			enabled: true,
			ownership: 'ad-hoc',
		}),
		job({
			id: 'live-package',
			name: 'Package digest',
			enabled: true,
			ownership: 'package',
		}),
		job({
			id: 'upcoming-once',
			name: 'Tomorrow ping',
			enabled: false,
			scheduleType: 'once',
			ownership: 'ad-hoc',
			nextRunAt: '2026-07-28T09:00:00.000Z',
		}),
		job({
			id: 'failed-once',
			name: 'Failed ping',
			enabled: false,
			scheduleType: 'once',
			ownership: 'ad-hoc',
			nextRunAt: '2026-07-20T09:00:00.000Z',
		}),
		job({
			id: 'disabled-package',
			name: 'Old package digest',
			enabled: false,
			scheduleType: 'cron',
			ownership: 'package',
		}),
	]

	expect(
		filterAccountJobs(jobs, {
			view: 'active',
			ownership: 'all',
			search: '',
			nowMs,
		}).map((item) => item.id),
	).toEqual(['live-cron', 'live-package', 'upcoming-once'])

	expect(
		filterAccountJobs(jobs, {
			view: 'history',
			ownership: 'all',
			search: '',
			nowMs,
		}).map((item) => item.id),
	).toEqual(['failed-once', 'disabled-package'])

	expect(
		filterAccountJobs(jobs, {
			view: 'all',
			ownership: 'all',
			search: '',
			nowMs,
		}).map((item) => item.id),
	).toEqual([
		'live-cron',
		'live-package',
		'upcoming-once',
		'failed-once',
		'disabled-package',
	])

	expect(
		filterAccountJobs(jobs, {
			view: 'active',
			ownership: 'package',
			search: '',
			nowMs,
		}).map((item) => item.id),
	).toEqual(['live-package'])

	expect(
		filterAccountJobs(jobs, {
			view: 'history',
			ownership: 'ad-hoc',
			search: 'failed',
			nowMs,
		}).map((item) => item.id),
	).toEqual(['failed-once'])

	expect(
		filterAccountJobs(
			[
				job({
					id: 'named-package',
					name: 'Nightly sync',
					ownership: 'package',
					packageName: 'State Store',
				}),
			],
			{
				view: 'all',
				ownership: 'all',
				search: 'state store',
				nowMs,
			},
		).map((item) => item.id),
	).toEqual(['named-package'])
})
