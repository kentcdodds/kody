import { expect, test } from 'vitest'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpToml,
	buildCursorMcpJson,
	buildKodyAppIconUrl,
	buildOpenCodeMcpJson,
	buildVsCodeMcpJson,
	mcpClientTabs,
} from './onboarding-mcp-clients.ts'

const mcpServerUrl = 'https://heykody.dev/mcp'

test('onboarding MCP client builders emit the structured configs each host expects', () => {
	expect(mcpClientTabs.map((tab) => tab.id)).toEqual([
		'cursor',
		'chatgpt',
		'codex',
		'claude-desktop',
		'grok',
		'claude-code',
		'opencode',
		'vscode',
		'other',
	])
	expect(
		mcpClientTabs.filter((tab) => tab.isNonCodingAgent).map((tab) => tab.id),
	).toEqual(['chatgpt', 'claude-desktop', 'grok'])

	expect(JSON.parse(buildCursorMcpJson(mcpServerUrl))).toEqual({
		mcpServers: {
			kody: {
				url: mcpServerUrl,
			},
		},
	})
	expect(JSON.parse(buildClaudeCodeMcpJson(mcpServerUrl))).toEqual({
		mcpServers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
	expect(buildClaudeCodeAddCommand(mcpServerUrl)).toBe(
		`claude mcp add --transport http -s user kody ${mcpServerUrl}`,
	)
	expect(JSON.parse(buildVsCodeMcpJson(mcpServerUrl))).toEqual({
		servers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
	expect(JSON.parse(buildOpenCodeMcpJson(mcpServerUrl))).toEqual({
		mcp: {
			kody: {
				type: 'remote',
				url: mcpServerUrl,
				enabled: true,
			},
		},
	})
	expect(buildCodexMcpToml(mcpServerUrl)).toBe(
		['[mcp_servers.kody]', `url = "${mcpServerUrl}"`, ''].join('\n'),
	)
	expect(buildKodyAppIconUrl(mcpServerUrl)).toBe(
		'https://heykody.dev/apple-touch-icon.png',
	)
})
