import { createListDetailRoute } from '#client/list-detail-route.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	readAccountActivityStatusFilter,
	readAccountActivitySurfaceFilter,
	readAccountActivityTriageFilter,
	readAccountActivityViewFilter,
	type AccountActivityStatusFilter,
	type AccountActivitySurfaceFilter,
	type AccountActivityTriageFilter,
	type AccountActivityViewFilter,
} from '#universal/account-activity-filters.ts'
import {
	type AccountActivityLoaderData,
	type AccountActivityRunDetail,
	type AccountActivityRunListItem,
} from '#universal/loader-data.ts'
import { colors } from '#universal/styles/tokens.ts'

export {
	activityEmptyLabel,
	buildActivitySearch,
	readAccountActivityStatusFilter as readStatusFilter,
	readAccountActivitySurfaceFilter as readSurfaceFilter,
	readAccountActivityTriageFilter as readTriageFilter,
	readAccountActivityViewFilter as readViewFilter,
} from '#universal/account-activity-filters.ts'

export const activityErrorReviewPrompt = [
	'Look at my open Kody activity errors.',
	'Start with runSummary, then runList for open errors, and runGet on the ones that matter.',
	'Explain each failure and recommend whether to ignore it, mark it resolved, or fix something.',
].join(' ')

export const accountActivityApiPath = '/account/activity.json'
export const activityRoute = createListDetailRoute('/account/activity')

export const viewFilterOptions: Array<{
	value: AccountActivityViewFilter
	label: string
}> = [
	{ value: 'errors', label: 'Open errors' },
	{ value: 'recent', label: 'Recent runs' },
]

export const statusFilterOptions: Array<{
	value: AccountActivityStatusFilter
	label: string
}> = [
	{ value: 'error', label: 'Errors' },
	{ value: 'all', label: 'All' },
	{ value: 'success', label: 'Success' },
	{ value: 'running', label: 'Running' },
]

export const triageFilterOptions: Array<{
	value: AccountActivityTriageFilter
	label: string
}> = [
	{ value: 'open', label: 'Open' },
	{ value: 'ignored', label: 'Ignored' },
	{ value: 'resolved', label: 'Resolved' },
	{ value: 'all', label: 'All triage' },
]

export const surfaceFilterOptions: Array<{
	value: AccountActivitySurfaceFilter
	label: string
}> = [
	{ value: 'all', label: 'All surfaces' },
	{ value: 'execute', label: 'Execute' },
	{ value: 'export', label: 'Export' },
	{ value: 'subscription', label: 'Subscription' },
	{ value: 'app_fetch', label: 'App fetch' },
	{ value: 'app_realtime', label: 'App realtime' },
	{ value: 'job', label: 'Job' },
	{ value: 'workflow', label: 'Workflow' },
	{ value: 'retriever', label: 'Retriever' },
	{ value: 'webhook', label: 'Webhook' },
]

export function surfaceLabel(surface: AccountActivityRunListItem['surface']) {
	const match = surfaceFilterOptions.find((option) => option.value === surface)
	return match?.label ?? surface
}

export function statusLabel(status: AccountActivityRunListItem['status']) {
	switch (status) {
		case 'error':
			return 'Error'
		case 'success':
			return 'Success'
		case 'running':
			return 'Running'
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

export function statusColor(status: AccountActivityRunListItem['status']) {
	switch (status) {
		case 'error':
			return colors.error
		case 'success':
			return colors.primary
		case 'running':
			return colors.textMuted
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

export function logLevelColor(
	level: AccountActivityRunDetail['logs'][number]['level'],
) {
	switch (level) {
		case 'error':
			return colors.error
		case 'warn':
			return colors.dangerHover
		case 'debug':
			return colors.textMuted
		case 'info':
		case 'log':
			return colors.text
		default: {
			const exhaustive: never = level
			return exhaustive
		}
	}
}

export function formatDurationMs(durationMs: number | null) {
	if (durationMs == null) return '—'
	if (durationMs < 1000) return `${durationMs} ms`
	return `${(durationMs / 1000).toFixed(1)} s`
}

export function runDisplayName(run: AccountActivityRunListItem) {
	return run.name?.trim() || surfaceLabel(run.surface)
}

export function triageLabel(
	run: Pick<AccountActivityRunListItem, 'status' | 'errorTriage'>,
) {
	if (run.status !== 'error') return '—'
	switch (run.errorTriage) {
		case 'ignored':
			return 'Ignored'
		case 'resolved':
			return 'Resolved'
		case null:
			return 'Open'
		default: {
			const exhaustive: never = run.errorTriage
			return exhaustive
		}
	}
}

export function getDataLatchKey(href: string) {
	const selection = activityRoute.getSelection(href)
	const view = readAccountActivityViewFilter(href)
	const status = readAccountActivityStatusFilter(href)
	const surface = readAccountActivitySurfaceFilter(href)
	const triage = readAccountActivityTriageFilter(href)
	const filterKey = `${view}:${status}:${surface}:${triage}`
	return selection.selectedId
		? `/account/activity/${encodeURIComponent(selection.selectedId)}?${filterKey}`
		: `/account/activity?${filterKey}`
}

export function buildActivityApiRequestUrl(
	href: string,
	cursor?: string | null,
) {
	const requestUrl = new URL(accountActivityApiPath, 'http://localhost')
	const view = readAccountActivityViewFilter(href)
	const status = readAccountActivityStatusFilter(href)
	const surface = readAccountActivitySurfaceFilter(href)
	const triage = readAccountActivityTriageFilter(href)
	if (view !== 'errors') requestUrl.searchParams.set('view', view)
	requestUrl.searchParams.set('status', status)
	if (surface !== 'all') requestUrl.searchParams.set('surface', surface)
	requestUrl.searchParams.set('error_triage', triage)
	const selectedRunId = activityRoute.getSelection(href).selectedId
	if (selectedRunId) {
		requestUrl.searchParams.set('selected', selectedRunId)
	}
	if (cursor) {
		requestUrl.searchParams.set('cursor', cursor)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountActivityRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildActivityApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountActivityLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load activity.')
	}
	return { accountActivity: payload }
}
