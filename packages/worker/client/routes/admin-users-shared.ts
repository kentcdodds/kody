import { createListDetailRoute } from '#client/list-detail-route.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	type AdminUserListItem,
	type AdminUsersLoaderData,
	type AdminUsersMutationData,
} from '#universal/loader-data.ts'
import {
	isAdminUserVerificationFilter,
	isStalledEmailVerificationDelivery,
	type AdminUserVerificationFilter,
} from '#universal/email-verification-delivery.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const adminUsersApiPath = '/admin/users.json'
export const adminUserUsageApiPath = '/admin/users/usage.json'

const { getSelection, buildDetailHref } = createListDetailRoute('/admin/users')

export { getSelection }

export function formatUsageLimit(limit: number) {
	return formatIntegerNumber(limit)
}

export function formatUsagePercent(value: number | null) {
	if (value === null) return '—'
	return `${Math.round(value * 100)}%`
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

/** Apply filter changes to the current href; filter changes re-anchor at page one. */
export function buildFilteredListHref(
	currentHref: string,
	nextFilters: Partial<AdminUserFilterState>,
) {
	const url = new URL(currentHref, 'http://localhost')
	const filters = { ...readFilterState(url.toString()), ...nextFilters }
	if (filters.search) url.searchParams.set('q', filters.search)
	else url.searchParams.delete('q')
	if (filters.role) url.searchParams.set('role', filters.role)
	else url.searchParams.delete('role')
	if (filters.verification) {
		url.searchParams.set('verification', filters.verification)
	} else url.searchParams.delete('verification')
	url.searchParams.delete('page')
	return `${url.pathname}${url.search}`
}

export function buildUserDetailHrefFrom(
	currentHref: string,
	stableUserId: string,
) {
	const url = new URL(currentHref, 'http://localhost')
	url.searchParams.delete('page')
	return buildDetailHref(stableUserId, url.search)
}

export function getDataKey(href: string) {
	const pathname = new URL(href, 'http://localhost').pathname
	return `${pathname}?${getListKey(href)}`
}

/**
 * Create reseeds from the refreshed first page, then prepends the created
 * row when oldest-first paging left it off page one. A failed refresh
 * keeps the current window and still splices that row in when present.
 */
export function nextAdminUsersWindowAfterCreate(input: {
	currentItems: Array<AdminUserListItem>
	currentHasMore: boolean
	currentTotal: number
	payload: AdminUsersMutationData
}) {
	const created = input.payload.updatedUser
	const baseItems = input.payload.listRefreshFailed
		? input.currentItems
		: input.payload.users
	const alreadyListed =
		created != null &&
		baseItems.some((item) => item.stableUserId === created.stableUserId)
	const items = created && !alreadyListed ? [created, ...baseItems] : baseItems
	if (input.payload.listRefreshFailed) {
		return {
			items,
			hasMore: input.currentHasMore,
			totalCount:
				created && !alreadyListed ? input.currentTotal + 1 : input.currentTotal,
		}
	}
	return {
		items,
		hasMore: input.payload.page * input.payload.pageSize < input.payload.total,
		totalCount: input.payload.total,
	}
}

/**
 * Role / plan / verification mutations patch the target in place so a
 * scrolled list keeps its loaded window. A create cannot use this path.
 */
export function nextAdminUsersWindowAfterMutation(input: {
	currentItems: Array<AdminUserListItem>
	payload: AdminUsersMutationData
	href: string
}) {
	const updatedUser = input.payload.updatedUser
	const { role, verification } = readFilterState(input.href)
	// The server ignores unknown role values, so only a known role counts
	// as an active filter — otherwise every mutation would wrongly remove
	// its target from the list.
	const activeRoleFilter = (
		input.payload.availableRoles as Array<string>
	).includes(role)
		? role
		: ''
	const matchesRoleFilter =
		!updatedUser ||
		!activeRoleFilter ||
		(updatedUser.roles as Array<string>).includes(activeRoleFilter)
	const matchesVerificationFilter =
		!updatedUser ||
		verification !== 'stalled' ||
		isStalledEmailVerificationDelivery({
			emailVerified: updatedUser.email_verified,
			delivery: updatedUser.email_verification_delivery,
		})
	const matchesActiveFilters = matchesRoleFilter && matchesVerificationFilter
	const nextItems = updatedUser
		? matchesActiveFilters
			? input.currentItems.map((item) =>
					item.stableUserId === updatedUser.stableUserId ? updatedUser : item,
				)
			: input.currentItems.filter(
					(item) => item.stableUserId !== updatedUser.stableUserId,
				)
		: input.currentItems
	return {
		items: nextItems,
		hasMore: nextItems.length < input.payload.total,
		totalCount: input.payload.total,
	}
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
