import { expect, test } from 'vitest'
import { shouldFetchMcpServerFavicon } from './mcp-server-favicon.ts'
import { buildMcpServerAutoLogoPath } from './mcp-server-logo.ts'

test('MCP server favicon fetch gate and auto-logo cache-buster path', () => {
	expect(
		shouldFetchMcpServerFavicon({
			url: 'https://mcp.agentcard.sh/mcp',
			logoKey: null,
			logoSource: null,
			faviconSourceHost: null,
		}),
	).toBe(true)
	expect(
		shouldFetchMcpServerFavicon({
			url: 'https://localhost:8787/mcp',
			logoKey: null,
			logoSource: null,
			faviconSourceHost: null,
		}),
	).toBe(false)
	expect(
		shouldFetchMcpServerFavicon({
			url: 'https://mcp.agentcard.sh/mcp',
			logoKey: 'user-mcp-server-logos/user-1/server-1/abc.png',
			logoSource: 'favicon',
			faviconSourceHost: 'agentcard.sh',
		}),
	).toBe(false)
	expect(
		shouldFetchMcpServerFavicon({
			url: 'https://mcp.example.com/mcp',
			logoKey: 'user-mcp-server-logos/user-1/server-1/abc.png',
			logoSource: 'favicon',
			faviconSourceHost: 'agentcard.sh',
		}),
	).toBe(true)

	expect(
		buildMcpServerAutoLogoPath({
			id: 'server-1',
			logoKey: null,
		}),
	).toBeNull()
	expect(
		buildMcpServerAutoLogoPath({
			id: 'server-1',
			logoKey: 'user-mcp-server-logos/user-1/server-1/0123456789abcdef.png',
		}),
	).toBe('/account/mcp-servers/logos/server-1?v=0123456789abcdef')
})
