import {
	type AccountIntegrationListItem,
	type AccountIntegrationsLoaderData,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { getDangerPillCss } from '#universal/styles/style-primitives.ts'

export const accountIntegrationsApiPath = routes.accountIntegrationsApi.href()
export const integrationsRoute = createListDetailRoute(
	'/account/integrations',
	{
		parseDetailId(pathname) {
			const prefix = `${routes.accountIntegrations.href()}/`
			if (!pathname.startsWith(prefix)) return null
			const segment = pathname.slice(prefix.length)
			if (!segment || segment.includes('/') || segment === 'approve') {
				return null
			}
			return decodePathSegment(segment)
		},
	},
)

const oauthAppsPathPrefix = `${routes.accountIntegrations.href()}/apps/`

function decodePathSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function readSelectedOauthAppSlug(href: string): string | null {
	const pathname = new URL(href, 'http://localhost').pathname
	if (!pathname.startsWith(oauthAppsPathPrefix)) return null
	const segment = pathname.slice(oauthAppsPathPrefix.length)
	if (!segment || segment.includes('/')) return null
	return decodePathSegment(segment)
}

function buildOauthAppHref(appSlug: string, search = '') {
	return routes.accountOauthAppDetail.href(
		{ appSlug },
		{ searchParams: new URLSearchParams(search) },
	)
}

export function oauthAppTitle(app: AccountOauthAppListItem) {
	return app.label?.trim() || app.provider || app.slug
}

export function isBuiltInApp(app: AccountOauthAppListItem) {
	return app.platform === true
}

export function integrationListId(app: AccountOauthAppListItem) {
	return isBuiltInApp(app) ? `platform:${app.slug}` : `user:${app.slug}`
}

function findAppForConnection(
	apps: ReadonlyArray<AccountOauthAppListItem>,
	connection: AccountIntegrationListItem,
) {
	return (
		apps.find(
			(app) =>
				app.slug === connection.appSlug &&
				isBuiltInApp(app) === Boolean(connection.platform),
		) ?? null
	)
}

export function buildIntegrationHref(
	app: AccountOauthAppListItem,
	search = '',
) {
	if (isBuiltInApp(app)) {
		const first = app.connections[0]
		return first
			? integrationsRoute.buildDetailHref(first.name, search)
			: routes.accountIntegrations.href()
	}
	return buildOauthAppHref(app.slug, search)
}

export function accountsConnectedCopy(count: number) {
	if (count === 0) return 'No accounts connected yet.'
	if (count === 1) return '1 account connected.'
	return `${count} accounts connected.`
}

export function connectionLabel(connection: {
	name: string
	accountLabel?: string | null
}) {
	return connection.accountLabel?.trim() || connection.name
}

export function deletedAppCopy(title: string, connectionCount: number) {
	if (connectionCount === 0) return `Deleted ${title}.`
	if (connectionCount === 1) return `Deleted ${title} and 1 account.`
	return `Deleted ${title} and ${connectionCount} accounts.`
}

export type IntegrationsSnapshot = {
	integrations: Array<AccountIntegrationListItem>
	apps: Array<AccountOauthAppListItem>
	href: string
}

export type IntegrationUsageDraft = {
	usageMode: 'any' | 'packages'
	allowedPackageIds: Array<string>
}

export function resolveIntegrationsSelection(input: {
	href: string
	apps: ReadonlyArray<AccountOauthAppListItem>
	integrations: ReadonlyArray<AccountIntegrationListItem>
}) {
	const selectedAppSlug = readSelectedOauthAppSlug(input.href)
	if (selectedAppSlug != null) {
		const app =
			input.apps.find(
				(entry) => entry.slug === selectedAppSlug && !isBuiltInApp(entry),
			) ?? null
		return {
			selectedApp: app,
			highlightedConnectionName: null as string | null,
			missingKind: app ? null : ('integration' as const),
		}
	}
	const connectionName = integrationsRoute.getSelection(input.href).selectedId
	if (connectionName == null) {
		return {
			selectedApp: null,
			highlightedConnectionName: null,
			missingKind: null,
		}
	}
	const connection = input.integrations.find(
		(entry) => entry.name === connectionName,
	)
	if (!connection) {
		return {
			selectedApp: null,
			highlightedConnectionName: connectionName,
			missingKind: 'connection' as const,
		}
	}
	const app = findAppForConnection(input.apps, connection)
	return {
		selectedApp: app,
		highlightedConnectionName: connectionName,
		missingKind: app ? null : ('connection' as const),
	}
}

export function filterOauthApps(
	apps: ReadonlyArray<AccountOauthAppListItem>,
	query: string,
) {
	return apps.filter((app) =>
		matchesSearchQuery(query, [
			app.slug,
			app.provider,
			app.label,
			app.clientId,
			app.clientSecretSecretName,
			app.tokenUrl,
			app.authorizeUrl,
			app.apiBaseUrl,
			...app.connections.map((connection) => connection.name),
			...app.connections.map((connection) => connection.accountLabel),
		]),
	)
}

export const dangerButtonCss = getDangerPillCss({ size: 'sm' })

/**
 * Latch key for the list payload. Selection segments and the client-side `q`
 * filter do not change the GET response, so keying the latch on the base path
 * avoids spurious refetches when only those URL parts change.
 */
export function getDataLatchKey(href: string) {
	const url = new URL(href, 'http://localhost')
	if (url.pathname === routes.accountIntegrationsApprove.href()) {
		return `${url.pathname}?${url.searchParams.get('name') ?? ''}&${url.searchParams.get('package_id') ?? ''}`
	}
	return '/account/integrations'
}

export function buildIntegrationsApiHref(href: string) {
	const url = new URL(href, 'http://localhost')
	const requestUrl = new URL(accountIntegrationsApiPath, url.origin)
	if (url.pathname === routes.accountIntegrationsApprove.href()) {
		const name = url.searchParams.get('name')
		const packageId = url.searchParams.get('package_id')
		if (name) requestUrl.searchParams.set('name', name)
		if (packageId) requestUrl.searchParams.set('package_id', packageId)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

export async function accountIntegrationsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(buildIntegrationsApiHref(url.toString()), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountIntegrationsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load integrations.')
	}
	return { accountIntegrations: payload }
}

export function formatList(values: Array<string> | null | undefined) {
	if (!values || values.length === 0) return 'None'
	return values.join(', ')
}

export function formatOptional(value: string | null | undefined) {
	return value?.trim() ? value : 'None'
}

export type ConnectionStatusLabel =
	| 'Needs you'
	| 'Service issue'
	| 'Connected'
	| 'Needs setup'

export function connectActionLabel(status: ConnectionStatusLabel) {
	if (status === 'Needs setup') return 'Connect'
	return 'Reconnect'
}

export function connectionStatusLabel(integration: AccountIntegrationListItem) {
	const failure = integration.lastAuthFailure
	if (failure) {
		return failure.who === 'you' ? 'Needs you' : 'Service issue'
	}
	return integration.authorization?.authorizeUrl ? 'Connected' : 'Needs setup'
}

export function shouldShowReconnectAction(
	integration: AccountIntegrationListItem,
) {
	if (!integration.lastAuthFailure) return true
	return integration.lastAuthFailure.who === 'you'
}

export function hostFromUrl(url: string | null | undefined) {
	if (!url) return null
	try {
		return new URL(url).hostname || null
	} catch {
		return null
	}
}

export async function postIntegrationsMutation(body: Record<string, unknown>) {
	const response = await fetch(accountIntegrationsApiPath, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		keepalive: true,
		body: JSON.stringify(body),
	})
	if (response.status === 401) {
		window.location.assign('/login')
		return
	}
	const payload = await readJson<{ ok?: boolean; error?: string }>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to complete that action.')
	}
}
