/**
 * `/account/connections` views. The page is one payload
 * (`/account/connected-agents.json`) rendered four exclusive ways: the
 * connected list, the full client grid on `/new` (Add connection), one
 * host's install steps on `/new/:agent`, and per-connection usage on
 * `/usage` (which also reads `/account/connection-usage.json`). The add and
 * usage views are their own pages, not nested chrome on the list.
 */

import {
	type McpClientKind,
	isMcpClientKind,
	mcpClientTabs,
} from '#universal/onboarding-mcp-clients.ts'
import {
	accountAliasPath,
	orgResourcePath,
	orgSlugFromPathname,
} from '#universal/org-pages.ts'
export type AccountConnectionsView =
	| { kind: 'list' }
	| { kind: 'new'; agent: McpClientKind | null }
	| { kind: 'usage' }

/**
 * Every named client, in catalog order, with no viewport split and nothing
 * folded under Not listed: the account page is where someone adds a second
 * or third host, so the phone-vs-desktop guess onboarding makes does not
 * apply. The generic MCP URL path is rendered below the grid instead of as
 * an `other` card.
 */
export const accountConnectionAgentIds: ReadonlyArray<McpClientKind> =
	mcpClientTabs.map((tab) => tab.id).filter((id) => id !== 'other')

export function isAccountConnectionAgent(
	value: string | null | undefined,
): value is McpClientKind {
	return isMcpClientKind(value) && value !== 'other'
}

/**
 * List and add URLs stay under `/@slug/…` when the person is already on an
 * org resource page, so Add / View steps / back do not bounce through
 * `/account/…` redirects (or stay on `/account` after a client navigation).
 */
export function accountConnectionsListHref(pathname?: string | null) {
	const slug = pathname ? orgSlugFromPathname(pathname) : null
	return slug ? orgResourcePath(slug, 'connections') : '/account/connections'
}

export function accountConnectionsNewHref(
	agent: McpClientKind | null,
	pathname?: string | null,
) {
	const slug = pathname ? orgSlugFromPathname(pathname) : null
	if (slug) {
		return orgResourcePath(slug, 'connections', agent ? `new/${agent}` : 'new')
	}
	if (!agent) return '/account/connections/new'
	return `/account/connections/new/${encodeURIComponent(agent)}`
}

/**
 * Usage drill-in. `connection` (a `ConnectionUsageEntry.id`) narrows it to
 * one connection.
 */
export function accountConnectionsUsageHref(
	pathname?: string | null,
	connection?: string | null,
) {
	const slug = pathname ? orgSlugFromPathname(pathname) : null
	const base = slug
		? orgResourcePath(slug, 'connections', 'usage')
		: '/account/connections/usage'
	return connection
		? `${base}?connection=${encodeURIComponent(connection)}`
		: base
}

/** `null` when the pathname is under the page but names an unknown agent. */
export function parseAccountConnectionsPathname(
	pathname: string,
): AccountConnectionsView | null {
	pathname = accountAliasPath(pathname)
	const base = '/account/connections'
	if (pathname === base || pathname === `${base}/`) return { kind: 'list' }
	if (pathname === `${base}/usage` || pathname === `${base}/usage/`) {
		return { kind: 'usage' }
	}
	const newBase = '/account/connections/new'
	if (pathname === newBase || pathname === `${newBase}/`) {
		return { kind: 'new', agent: null }
	}
	const prefix = `${newBase}/`
	if (!pathname.startsWith(prefix)) return null
	const segment = pathname.slice(prefix.length).replace(/\/$/u, '')
	if (!segment || segment.includes('/')) return null
	let decoded: string
	try {
		decoded = decodeURIComponent(segment)
	} catch {
		return null
	}
	return isAccountConnectionAgent(decoded)
		? { kind: 'new', agent: decoded }
		: null
}
