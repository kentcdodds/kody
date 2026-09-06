import { readJson } from '#client/routes/account-approval-shared.ts'
import { chartColor } from '#client/charts/chart-theme.ts'
import { monthShortNames } from '#client/charts/usage-metric-series.ts'
import {
	type AdminInsightsLoaderData,
	type AdminInsightsRunLogCompleteness,
	type AdminUsageMetric,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

export const adminInsightsApiPath = '/admin/insights.json'

export const planColors: Record<string, string> = {
	pro: chartColor.violet,
	free: chartColor.blue,
	standard: chartColor.emerald,
	none: chartColor.cyan,
}

export const workflowStatusColors: Record<string, string> = {
	complete: chartColor.emerald,
	completed: chartColor.emerald,
	running: chartColor.blue,
	queued: chartColor.cyan,
	waiting: chartColor.amber,
	paused: chartColor.amber,
	errored: chartColor.rose,
	failed: chartColor.rose,
	terminated: chartColor.fuchsia,
	unknown: chartColor.lime,
}

export const authCategoryColors: Record<string, string> = {
	auth: chartColor.blue,
	account: chartColor.emerald,
	admin: chartColor.amber,
	oauth: chartColor.violet,
}

export function isAdminInsightsPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/insights'
}

/** `2026-06-29` -> `Jun 29` */
export function formatDayLabel(dayKey: string) {
	const monthIndex = Number(dayKey.slice(5, 7)) - 1
	const dayOfMonth = Number(dayKey.slice(8, 10))
	return `${monthShortNames[monthIndex] ?? '?'} ${dayOfMonth}`
}

export function formatPlanLabel(plan: string) {
	return plan === 'none' ? 'No plan' : plan
}

export function formatDurationHours(durationMs: number) {
	if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`
	const hours = durationMs / (60 * 60 * 1000)
	if (hours < 10) return `${hours.toFixed(1)}h`
	return `${Math.round(hours)}h`
}

export function formatPressurePercent(value: number) {
	return `${Math.round(value * 100)}%`
}

export function adminUserDetailHref(stableUserId: string) {
	return routes.adminUserDetail.href({ stableUserId })
}

export const runtimeDurationMetricLabels: Record<AdminUsageMetric, string> = {
	execute: 'Executes',
	package_export: 'Package runs',
	package_static_call: 'Static package calls',
	job_run: 'Job runs',
	workflow_run: 'Workflow runs',
	outbound_fetch: 'Fetches',
	email_send: 'Email sends',
	email_received: 'Email receives',
	dynamic_worker_day: 'Unique worker-days',
	durable_object_gb_seconds: 'Durable Object duration (GB-s)',
}

/** Null when run-derived totals are complete; otherwise a user-facing warning. */
export function formatRunLogCompletenessWarning(
	completeness: AdminInsightsRunLogCompleteness,
): string | null {
	if (completeness.complete) return null
	return `Workflow and activation totals are partial — loaded RunLog snapshots for ${completeness.usersLoaded} of ${completeness.usersAttempted} users.`
}

export async function adminInsightsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminInsightsApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view admin insights.')
	}
	const payload = await readJson<AdminInsightsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load admin insights.')
	}
	return { adminInsights: payload }
}
