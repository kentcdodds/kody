import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { type AdminCodemodsLoaderData } from '#universal/loader-data.ts'

export type PageStatus = 'loading' | 'ready' | 'error'
export type RunMode = 'scan' | 'dry-run' | 'apply' | 'revert'
export type RunPhase = 'idle' | 'running' | 'complete' | 'error'

export type LiveRunItem = {
	itemId: string
	userId: string
	packageId: string
	kodyId: string
	status: string
	changedPaths: Array<string>
	findings: Array<{ path: string | null; message: string }>
	error: string | null
}

export const adminCodemodsApiPath = '/admin/codemods.json'
export const adminCodemodsRunApiPath = '/admin/codemods/run.json'
export const adminCodemodsRunStopApiPath = '/admin/codemods/run/stop.json'
export const maxRunSteps = 200

export const runModes = [
	'scan',
	'dry-run',
	'apply',
	'revert',
] as const satisfies ReadonlyArray<RunMode>

export function isAdminCodemodsPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/codemods'
}

export function parseCommaSeparatedIds(value: string): Array<string> {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

export function mergeSummaryCounts(
	left: Record<string, number>,
	right: Partial<Record<string, number>>,
) {
	const next = { ...left }
	for (const [status, count] of Object.entries(right)) {
		if (typeof count !== 'number') continue
		next[status] = (next[status] ?? 0) + count
	}
	return next
}

export function formatSummaryCounts(summary: Record<string, number>) {
	const entries = Object.entries(summary).sort(([left], [right]) =>
		left.localeCompare(right),
	)
	if (entries.length === 0) return 'No items yet'
	return entries.map(([status, count]) => `${status}: ${count}`).join(' · ')
}

export function formatFindings(
	findings: Array<{ path: string | null; message: string }>,
) {
	if (findings.length === 0) return '—'
	return findings
		.map((finding) =>
			finding.path ? `${finding.path}: ${finding.message}` : finding.message,
		)
		.join('; ')
}

export async function adminCodemodsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminCodemodsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view package codemods.')
	}
	const payload = await readJson<AdminCodemodsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load package codemods.')
	}
	return { adminCodemods: payload }
}
