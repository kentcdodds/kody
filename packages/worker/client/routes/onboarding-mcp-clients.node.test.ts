import { expect, test } from 'vitest'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpToml,
	buildCursorInstallUrl,
	buildCursorMcpJson,
	buildKodyAppIconUrl,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
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

	const cursorInstallUrl = new URL(buildCursorInstallUrl(mcpServerUrl))
	expect(cursorInstallUrl.protocol).toBe('cursor:')
	expect(cursorInstallUrl.hostname).toBe('anysphere.cursor-deeplink')
	expect(cursorInstallUrl.pathname).toBe('/mcp/install')
	expect(cursorInstallUrl.searchParams.get('name')).toBe('kody')
	const cursorConfig = cursorInstallUrl.searchParams.get('config')
	expect(cursorConfig).toMatch(/^[\w-]+$/u)
	expect(
		JSON.parse(
			atob(
				cursorConfig!
					.replaceAll('-', '+')
					.replaceAll('_', '/')
					.padEnd(Math.ceil(cursorConfig!.length / 4) * 4, '='),
			),
		),
	).toEqual({ url: mcpServerUrl })

	const vsCodeInstallUrl = buildVsCodeInstallUrl(mcpServerUrl)
	expect(vsCodeInstallUrl.startsWith('vscode:mcp/install?')).toBe(true)
	expect(
		JSON.parse(
			decodeURIComponent(vsCodeInstallUrl.slice('vscode:mcp/install?'.length)),
		),
	).toEqual({
		name: 'kody',
		type: 'http',
		url: mcpServerUrl,
	})
})
