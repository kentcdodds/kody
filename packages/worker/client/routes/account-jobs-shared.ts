import { createListDetailRoute } from '#client/list-detail-route.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { type AccountJobsViewFilter } from '#client/routes/account-jobs-filter.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AccountJobListItem,
	type AccountJobsLoaderData,
} from '#universal/loader-data.ts'
import { colors } from '#universal/styles/tokens.ts'

export const accountJobsApiPath = '/account/jobs.json'
export const jobsRoute = createListDetailRoute('/account/jobs')

export const viewFilterOptions: Array<{
	value: AccountJobsViewFilter
	label: string
}> = [
	{ value: 'active', label: 'Active' },
	{ value: 'history', label: 'History' },
	{ value: 'all', label: 'All' },
]

export type AccountJobsActionPayload = AccountJobsLoaderData & {
	runNow?: { ok: boolean; error: string | null; deletedAfterRun: boolean }
}

export type PostAccountJobsAction = (input: {
	body: Record<string, unknown>
	successMessage: (payload: AccountJobsActionPayload) => string | null
	failureMessage: string
	afterSuccess?: (payload: AccountJobsActionPayload) => void
}) => Promise<void>

/**
 * Latch key includes the selected job id because detail fields (recent runs,
 * params, errors) are loaded with `?selected=`. The client-side `q` / `view`
 * filters are omitted so search typing and filter toggles do not refetch.
 */
export function getDataLatchKey(href: string) {
	const selectedId = jobsRoute.getSelection(href).selectedId
	return selectedId
		? `/account/jobs?selected=${encodeURIComponent(selectedId)}`
		: '/account/jobs'
}

export function emptyJobsMessage(input: {
	totalCount: number
	filteredCount: number
	view: AccountJobsViewFilter
	search: string
}) {
	if (input.totalCount === 0) {
		return 'No scheduled jobs yet. Ask Kody to add one on a saved package.'
	}
	if (input.filteredCount > 0) return null
	if (input.search || input.view === 'all') {
		return 'No jobs match the current filters.'
	}
	if (input.view === 'history') {
		return 'No inactive or past jobs.'
	}
	return 'No active or upcoming jobs. Switch to History or All to see other jobs.'
}

export function buildJobsApiRequestUrl(href: string) {
	const requestUrl = new URL(accountJobsApiPath, 'http://localhost')
	const selectedJobId = jobsRoute.getSelection(href).selectedId
	if (selectedJobId) {
		requestUrl.searchParams.set('selected', selectedJobId)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountJobsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildJobsApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountJobsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load scheduled jobs.')
	}
	return { accountJobs: payload }
}

export function packageLabel(
	job: Pick<AccountJobListItem, 'ownership' | 'packageName'>,
) {
	if (job.ownership === 'package') {
		return job.packageName ?? 'Package'
	}
	return '—'
}

export function statusLabel(
	job: Pick<
		AccountJobListItem,
		'enabled' | 'killSwitchEnabled' | 'dueNow' | 'lastRunStatus' | 'expired'
	>,
) {
	if (job.killSwitchEnabled) return 'Kill switch on'
	if (job.expired) return 'Expired'
	if (!job.enabled) return 'Disabled'
	if (job.dueNow) return 'Due now'
	if (job.lastRunStatus === 'error') return 'Last run failed'
	if (job.lastRunStatus === 'success') return 'Last run ok'
	return 'Scheduled'
}

export function statusColor(
	job: Pick<
		AccountJobListItem,
		'enabled' | 'killSwitchEnabled' | 'dueNow' | 'lastRunStatus' | 'expired'
	>,
) {
	if (job.killSwitchEnabled) return colors.error
	if (job.expired) return colors.textMuted
	if (!job.enabled) return colors.textMuted
	if (job.dueNow) return colors.primary
	if (job.lastRunStatus === 'error') return colors.error
	if (job.lastRunStatus === 'success') return colors.primary
	return colors.textMuted
}

export function formatDurationMs(durationMs: number | null) {
	if (durationMs == null) return '—'
	if (durationMs < 1000) return `${durationMs} ms`
	return `${(durationMs / 1000).toFixed(1)} s`
}
