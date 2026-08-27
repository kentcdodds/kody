import { expect, test } from 'vitest'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpAddCommand,
	buildCodexMcpToml,
	buildCopilotCliAddCommand,
	buildCopilotCliMcpJson,
	buildGrokCliAddCommand,
	buildGrokCliMcpToml,
	buildKodyAppIconUrl,
	buildKodyCliInstallCommand,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	defaultKodyMcpUrl,
	isDefaultKodyMcpUrl,
	mcpClientTabs,
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
		'grok-bot',
		'claude-code',
		'opencode',
		'copilot',
		'copilot-app',
		'other',
	])
	expect(
		mcpClientTabs.filter((tab) => tab.isNonCodingAgent).map((tab) => tab.id),
	).toEqual(['chatgpt', 'claude-desktop', 'grok', 'grok-bot', 'copilot-app'])

	expect(isDefaultKodyMcpUrl(`${mcpServerUrl}/`)).toBe(true)
	expect(isDefaultKodyMcpUrl('http://localhost:3742/mcp')).toBe(false)
	expect(buildKodyCliInstallCommand(mcpServerUrl)).toBe(
		'npx @kodycodes/cli install',
	)
	expect(buildKodyCliInstallCommand(`${mcpServerUrl}/`)).toBe(
		'npx @kodycodes/cli install',
	)
	expect(buildKodyCliInstallCommand('http://localhost:3742/mcp')).toBe(
		'npx @kodycodes/cli install --mcp-url http://localhost:3742/mcp',
	)

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
	expect(buildOpenCodeMcpAddCommand(mcpServerUrl)).toBe(
		`opencode mcp add kody --url ${mcpServerUrl}`,
	)
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
