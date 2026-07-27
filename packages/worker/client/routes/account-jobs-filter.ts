import { matchesSearchQuery } from '#client/search-filter.ts'

export type AccountJobsViewFilter = 'active' | 'history' | 'all'
export type AccountJobsOwnershipFilter = 'all' | 'ad-hoc' | 'package'

export type FilterableAccountJob = {
	id: string
	name: string
	ownership: string
	scheduleSummary: string
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	preserved?: boolean
	dueNow: boolean
	lastRunStatus: string | null
	nextRunAt: string
	scheduleType: 'once' | 'interval' | 'cron'
}

/**
 * Ops-surface rule: live work plus upcoming one-offs.
 * enabled OR (once schedule with a future run_at / nextRunAt).
 */
export function isActiveAccountJob(
	job: Pick<FilterableAccountJob, 'enabled' | 'scheduleType' | 'nextRunAt'>,
	nowMs: number = Date.now(),
) {
	if (job.enabled) return true
	if (job.scheduleType !== 'once') return false
	const runAtMs = Date.parse(job.nextRunAt)
	return Number.isFinite(runAtMs) && runAtMs > nowMs
}

export function readJobsViewFilter(href: string): AccountJobsViewFilter {
	const value = new URL(href, 'http://localhost').searchParams
		.get('view')
		?.trim()
	if (value === 'history' || value === 'all') return value
	return 'active'
}

export function readJobsOwnershipFilter(
	href: string,
): AccountJobsOwnershipFilter {
	const value = new URL(href, 'http://localhost').searchParams
		.get('ownership')
		?.trim()
	if (value === 'ad-hoc' || value === 'package') return value
	return 'all'
}

export function readJobsSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

export function filterAccountJobs<Job extends FilterableAccountJob>(
	jobs: ReadonlyArray<Job>,
	input: {
		view: AccountJobsViewFilter
		ownership: AccountJobsOwnershipFilter
		search: string
		nowMs?: number
	},
): Array<Job> {
	const nowMs = input.nowMs ?? Date.now()
	return jobs.filter((job) => {
		if (input.ownership !== 'all' && job.ownership !== input.ownership) {
			return false
		}
		if (input.view !== 'all') {
			const active = isActiveAccountJob(job, nowMs)
			if (input.view === 'active' ? !active : active) return false
		}
		return matchesSearchQuery(input.search, [
			job.name,
			job.id,
			job.ownership,
			job.scheduleSummary,
			job.timezone,
			job.lastRunStatus,
			job.enabled ? 'enabled' : 'disabled',
			job.killSwitchEnabled ? 'kill switch' : '',
			job.preserved ? 'preserved' : '',
			job.dueNow ? 'due' : '',
			job.scheduleType,
		])
	})
}
