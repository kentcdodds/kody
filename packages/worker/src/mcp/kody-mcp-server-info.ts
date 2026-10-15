import { type Implementation } from '@modelcontextprotocol/sdk/types.js'
import { buildKodyToolIcons } from './tools/tool-icons.ts'

/**
 * Shared MCP `initialize` / `server/discover` serverInfo for both protocol
 * lanes. Keep `name` and `version` stable; title/description/websiteUrl/icons
 * are display metadata the SDK's Implementation type supports.
 */
export const kodyMcpServerName = 'kody-mcp' as const

/** Advertised on both protocol lanes and the public MCP server card. */
export const kodyMcpServerVersion = '1.0.0' as const

export const kodyMcpServerWebsiteUrl = 'https://kody.codes' as const

/** One-line agent-facing purpose (Implementation.description). */
export const kodyMcpServerDescription =
	"Your agents' cloud: search the catalog and run sandboxed modules with credentials, packages, jobs, and integrations." as const

/**
 * Build handshake `serverInfo`. Icons need absolute URIs (SEP-973), so pass
 * the caller's base URL when known; without it icons are omitted (unit tests).
 */
export function buildKodyMcpServerInfo(
	baseUrl?: string | null,
): Implementation {
	const icons = buildKodyToolIcons(baseUrl)
	return {
		name: kodyMcpServerName,
		version: kodyMcpServerVersion,
		title: 'Kody',
		description: kodyMcpServerDescription,
		websiteUrl: kodyMcpServerWebsiteUrl,
		...(icons ? { icons } : {}),
	}
}
