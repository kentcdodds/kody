import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { orgAccountApiFetchInit } from '#client/org-account-api.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type CredentialListFilters,
	type CredentialListItem,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	readCredentialListFilters,
	type SetCredentialHostsResponse,
	writeCredentialListQuery,
} from '#universal/credentials-list.ts'
import { orgResourcePath, orgSlugFromPathname } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'

export const credentialsRoute = createListDetailRoute('/account/credentials')

/**
 * One payload per org and selection; filters only change which rows show.
 * The org comes from the page path because the fetch binds it by referrer.
 */
export function credentialsDataKey(href: string) {
	const orgSlug =
		orgSlugFromPathname(new URL(href, 'http://localhost').pathname) ?? ''
	const selectedId = credentialsRoute.getSelection(href).selectedId
	const key = `/account/credentials?org=${encodeURIComponent(orgSlug)}`
	return selectedId ? `${key}&selected=${encodeURIComponent(selectedId)}` : key
}

export function readCredentialListFiltersFromHref(href: string) {
	return readCredentialListFilters(
		new URL(href, 'http://localhost').searchParams,
	)
}

/** `href` with `filters` as its query, keeping unrelated params. */
export function writeCredentialListFilters(
	href: string,
	filters: CredentialListFilters,
) {
	const url = new URL(href, 'http://localhost')
	writeCredentialListQuery(url.searchParams, filters)
	return `${url.pathname}${url.search}`
}

/**
 * The page that edits `credential` today. Personal credentials granted to a
 * team org are managed in the viewer's personal org.
 */
export function credentialManageHref(
	credential: CredentialListItem,
	page: Pick<AccountCredentialsResponse, 'orgSlug' | 'personalOrgSlug'>,
) {
	const slug =
		credential.scope === 'personal' && page.personalOrgSlug
			? page.personalOrgSlug
			: page.orgSlug
	switch (credential.kind) {
		case 'secret':
		case 'url':
		case 'login':
		case 'signing':
			return orgResourcePath(
				slug,
				'secrets',
				buildAccountSecretPath(
					credential.packageId
						? {
								name: credential.name,
								scope: 'package',
								packageId: credential.packageId,
							}
						: { name: credential.name, scope: 'user' },
				).replace(/^\/account\/secrets\/?/, ''),
			)
		case 'oauth':
			return orgResourcePath(
				slug,
				'integrations',
				encodeURIComponent(credential.name),
			)
		case 'mcp':
			return orgResourcePath(
				slug,
				'mcp-servers',
				encodeURIComponent(credential.id),
			)
		default: {
			const exhaustive: never = credential.kind
			return exhaustive
		}
	}
}

const accountCredentialsApiPath = routes.accountCredentialsApi.href()

/** `/account/credentials.json` for the page at `href`, or null when signed out. */
export async function fetchAccountCredentials(
	href: string,
	signal: AbortSignal,
) {
	const selectedId = credentialsRoute.getSelection(href).selectedId
	const requestPath = selectedId
		? `${accountCredentialsApiPath}?${new URLSearchParams({ selected: selectedId })}`
		: accountCredentialsApiPath
	const response = await fetch(
		requestPath,
		orgAccountApiFetchInit(href, signal),
	)
	if (response.status === 401) return null
	const payload = await readJson<AccountCredentialsResponse>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load credentials.')
	}
	return payload
}

/** Replaces a credential's editable hosts from the page at `href`. */
export async function saveCredentialHosts(input: {
	href: string
	credentialId: string
	hosts: ReadonlyArray<string>
}) {
	const init = orgAccountApiFetchInit(input.href)
	const response = await fetch(routes.accountCredentialsApiPost.href(), {
		...init,
		method: 'POST',
		headers: { ...init.headers, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			action: 'setHosts',
			credentialId: input.credentialId,
			hosts: input.hosts,
		}),
	})
	const payload = await readJson<
		SetCredentialHostsResponse | { ok: false; error?: string }
	>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error(
			(payload && !payload.ok && payload.error) || 'Could not save the hosts.',
		)
	}
	return payload
}

export async function accountCredentialsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchAccountCredentials(url.href, signal)
	if (!payload) return routeLoaderRedirect('/login')
	return { accountCredentials: payload }
}
