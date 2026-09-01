import { matchesSearchQuery } from '#client/search-filter.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AdminProviderMark,
	type AdminProviderMarksLoaderData,
} from '#universal/loader-data.ts'

export const adminProviderMarksApiPath = '/admin/provider-marks.json'

export function isAdminProviderMarksPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/provider-marks'
}

export function splitAliasInput(raw: string): Array<string> {
	return raw
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean)
}

export function filterMarks(marks: Array<AdminProviderMark>, search: string) {
	return marks.filter((mark) =>
		matchesSearchQuery(search, [mark.slug, mark.label, ...mark.aliases]),
	)
}

export async function adminProviderMarksRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminProviderMarksApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view provider marks.')
	}
	const payload = await readJson<AdminProviderMarksLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load provider marks.')
	}
	return { adminProviderMarks: payload } as RouteLoaderResult
}
