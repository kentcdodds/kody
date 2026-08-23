import { expect, test } from 'vitest'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpAddCommand,
	buildCodexMcpToml,
	buildCopilotCliAddCommand,
	buildCopilotCliMcpJson,
	buildCursorInstallUrl,
	buildCursorMcpJson,
	buildGrokCliAddCommand,
	buildGrokCliMcpToml,
	buildKodyAppIconUrl,
	buildKodyCliInstallCommand,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	codexMcpLoginCommand,
	defaultKodyMcpUrl,
	mcpClientTabs,
	openCodeMcpAuthCommand,
} from './onboarding-mcp-clients.ts'

const mcpServerUrl = defaultKodyMcpUrl

test('onboarding MCP client builders emit the structured configs each host expects', () => {
	expect(mcpClientTabs.map((tab) => tab.id)).toEqual([
		'cursor',
		'chatgpt',
		'codex',
		'claude-desktop',
		'grok',
		'grok-cli',
		'claude-code',
		'opencode',
		'copilot',
		'copilot-app',
		'other',
	])
	expect(
		mcpClientTabs.filter((tab) => tab.isNonCodingAgent).map((tab) => tab.id),
	).toEqual(['chatgpt', 'claude-desktop', 'grok', 'copilot-app'])
	expect(mcpClientTabs.find((tab) => tab.id === 'grok')?.label).toBe('Grok.com')
	expect(mcpClientTabs.find((tab) => tab.id === 'grok-cli')?.label).toBe(
		'Grok CLI',
	)
	expect(mcpClientTabs.find((tab) => tab.id === 'copilot')?.label).toBe(
		'Copilot',
	)
	expect(mcpClientTabs.find((tab) => tab.id === 'copilot-app')?.label).toBe(
		'Copilot App',
	)

	expect(buildKodyCliInstallCommand(mcpServerUrl)).toBe(
		'npx @kodycodes/cli install',
	)
	expect(buildKodyCliInstallCommand(`${mcpServerUrl}/`)).toBe(
		'npx @kodycodes/cli install',
	)
	expect(buildKodyCliInstallCommand('http://localhost:3742/mcp')).toBe(
		'npx @kodycodes/cli install --mcp-url http://localhost:3742/mcp',
	)

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
	expect(buildCodexMcpAddCommand(mcpServerUrl)).toBe(
		`codex mcp add kody --url ${mcpServerUrl}`,
	)
	expect(codexMcpLoginCommand).toBe('codex mcp login kody')
	expect(buildOpenCodeMcpAddCommand(mcpServerUrl)).toBe(
		`opencode mcp add kody --url ${mcpServerUrl}`,
	)
	expect(openCodeMcpAuthCommand).toBe('opencode mcp auth kody')
	expect(JSON.parse(buildVsCodeMcpJson(mcpServerUrl))).toEqual({
		servers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
	expect(buildCopilotCliAddCommand(mcpServerUrl)).toBe(
		`copilot mcp add --transport http kody ${mcpServerUrl}`,
	)
	expect(JSON.parse(buildCopilotCliMcpJson(mcpServerUrl))).toEqual({
		mcpServers: {
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
	expect(buildGrokCliAddCommand(mcpServerUrl)).toBe(
		`grok mcp add --transport http --scope user kody ${mcpServerUrl}`,
	)
	expect(buildGrokCliMcpToml(mcpServerUrl)).toBe(
		['[mcp_servers.kody]', `url = "${mcpServerUrl}"`, ''].join('\n'),
	)
	expect(buildKodyAppIconUrl(mcpServerUrl)).toBe(
		'https://kody.codes/apple-touch-icon.png',
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
