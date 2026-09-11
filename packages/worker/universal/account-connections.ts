/**
 * `/account/connections` views. The page is one payload
 * (`/account/connected-agents.json`) rendered three ways: the connected
 * list, the full client grid (Add connection), and one host's install steps.
 */

import {
	type McpClientKind,
	isMcpClientKind,
	mcpClientTabs,
} from '#universal/onboarding-mcp-clients.ts'
import { routes } from '#universal/routes.ts'

export type AccountConnectionsView =
	| { kind: 'list' }
	| { kind: 'new'; agent: McpClientKind | null }

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

export function accountConnectionsNewHref(agent: McpClientKind | null) {
	if (!agent) return routes.accountConnectionNew.href()
	return routes.accountConnectionNewAgent.href({ agent })
}

/** `null` when the pathname is under the page but names an unknown agent. */
export function parseAccountConnectionsPathname(
	pathname: string,
): AccountConnectionsView | null {
	const base = routes.accountConnections.href()
	if (pathname === base || pathname === `${base}/`) return { kind: 'list' }
	const newBase = routes.accountConnectionNew.href()
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
