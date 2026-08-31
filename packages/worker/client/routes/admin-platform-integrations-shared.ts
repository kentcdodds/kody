import { createListDetailRoute } from '#client/list-detail-route.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AdminPlatformIntegrationApp,
	type AdminPlatformIntegrationsLoaderData,
} from '#universal/loader-data.ts'

export const adminPlatformIntegrationsApiPath =
	'/admin/platform-integrations.json'
export const platformIntegrationsRoute = createListDetailRoute(
	'/admin/platform-integrations',
)
export type PageStatus = 'loading' | 'ready' | 'error'
export type ActionState =
	| 'idle'
	| 'saving-form'
	| 'toggling-enabled'
	| 'deleting'
export type TokenExchangeStyleOption =
	| 'default'
	| 'form'
	| 'basic-json'
	| 'basic-form'

export function isAdminPlatformIntegrationsPath(href: string) {
	return platformIntegrationsRoute.isRoutePath(href)
}

export function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

/**
 * Search is client-side over the already-loaded apps list. Loading keys on
 * pathname only so typing in `q` does not refetch or unmount the table.
 */
export function getDataKey(href: string) {
	return new URL(href, 'http://localhost').pathname
}

export function getCurrentSearch(href: string) {
	return new URL(href, 'http://localhost').search
}

export function buildHrefWithUpdatedSearch(href: string, search: string) {
	const nextUrl = new URL(href, 'http://localhost')
	if (search) nextUrl.searchParams.set('q', search)
	else nextUrl.searchParams.delete('q')
	return `${nextUrl.pathname}${nextUrl.search}`
}

export function filterApps(
	apps: Array<AdminPlatformIntegrationApp>,
	search: string,
) {
	return apps.filter((app) =>
		matchesSearchQuery(search, [app.slug, app.provider, app.label]),
	)
}

export function joinList(items: Array<string>): string {
	return items.join(', ')
}

export function splitListInput(raw: string): Array<string> {
	return raw
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean)
}

export function formatExtraAuthorizeParams(
	params: Record<string, string>,
): string {
	return Object.entries(params)
		.map(([key, value]) => `${key}=${value}`)
		.join('\n')
}

export function parseExtraAuthorizeParams(raw: string): Record<string, string> {
	const result: Record<string, string> = {}
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		const equalsIndex = trimmed.indexOf('=')
		if (equalsIndex === -1) continue
		const key = trimmed.slice(0, equalsIndex).trim()
		const value = trimmed.slice(equalsIndex + 1).trim()
		if (key) result[key] = value
	}
	return result
}

export function formatTokenExchangeStyle(
	value: AdminPlatformIntegrationApp['tokenExchangeStyle'],
): TokenExchangeStyleOption {
	if (value === 'form' || value === 'basic-json' || value === 'basic-form') {
		return value
	}
	return 'default'
}

export async function adminPlatformIntegrationsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminPlatformIntegrationsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view platform integrations.')
	}
	const payload = await readJson<AdminPlatformIntegrationsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load platform integrations.')
	}
	return { adminPlatformIntegrations: payload } as RouteLoaderResult
}
