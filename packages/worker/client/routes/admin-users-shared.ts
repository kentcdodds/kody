import { createListDetailRoute } from '#client/list-detail-route.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { type AdminUsersLoaderData } from '#universal/loader-data.ts'
import {
	isAdminUserVerificationFilter,
	type AdminUserVerificationFilter,
} from '#universal/email-verification-delivery.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

export const adminUsersApiPath = '/admin/users.json'
export const adminUserUsageApiPath = '/admin/users/usage.json'

const {
	isRoutePath: isAdminUsersListDetailPath,
	getSelection,
	buildDetailHref,
} = createListDetailRoute('/admin/users')

export { getSelection, buildDetailHref }

export function formatUsageLimit(limit: number) {
	return formatIntegerNumber(limit)
}

export function formatUsagePercent(value: number | null) {
	if (value === null) return '—'
	return `${Math.round(value * 100)}%`
}

export function isAdminUsersPath(href: string) {
	const path = new URL(href, 'http://localhost').pathname
	return path === '/admin' || isAdminUsersListDetailPath(href)
}

export type AdminUserFilterState = {
	search: string
	role: string
	verification: AdminUserVerificationFilter | ''
}

/** Read the `q`/`role`/`verification` filter params the server applies. */
export function readFilterState(href: string): AdminUserFilterState {
	const url = new URL(href, 'http://localhost')
	const rawVerification = url.searchParams.get('verification')?.trim() ?? ''
	return {
		search: url.searchParams.get('q')?.trim() ?? '',
		role: url.searchParams.get('role')?.trim() ?? '',
		verification: isAdminUserVerificationFilter(rawVerification)
			? rawVerification
			: '',
	}
}

/**
 * The list window only depends on the filters, not on which user is
 * selected — selection-only navigations keep the loaded scroll window.
 */
export function getListKey(href: string) {
	const filters = readFilterState(href)
	return `q=${filters.search}&role=${filters.role}&verification=${filters.verification}`
}

export function getDataKey(href: string) {
	const pathname = new URL(href, 'http://localhost').pathname
	return `${pathname}?${getListKey(href)}`
}

export function parseSelectedStableUserId(value: string | null): string | null {
	if (!value || !/^[a-f0-9]{64}$/.test(value)) return null
	return value
}

/**
 * Translate a detail pathname into the JSON API's `?selected=` param and
 * drop a stale `?page=` so initial loads always re-anchor at page one.
 */
export function buildAdminUsersApiRequestUrl(
	href: string,
	options?: { page?: number; includeSelected?: boolean },
) {
	const pageUrl = new URL(href, 'http://localhost')
	const requestUrl = new URL(adminUsersApiPath, 'http://localhost')
	requestUrl.search = pageUrl.search
	requestUrl.searchParams.delete('page')
	if (options?.page != null) {
		requestUrl.searchParams.set('page', String(options.page))
	}
	const selectedId = getSelection(href).selectedId
	if (selectedId && options?.includeSelected !== false) {
		requestUrl.searchParams.set('selected', selectedId)
	} else {
		requestUrl.searchParams.delete('selected')
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function adminUsersRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildAdminUsersApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view admin users.')
	}
	const payload = await readJson<AdminUsersLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load admin users.')
	}
	return { adminUsers: payload }
}
