import { expect, test } from 'vitest'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpToml,
	buildCursorMcpJson,
	buildOpenCodeMcpJson,
	buildVsCodeMcpJson,
	mcpClientTabs,
	nonCodingAgentNote,
} from './onboarding-mcp-clients.ts'

const mcpServerUrl = 'https://heykody.dev/mcp'

test('mcp client tabs cover the popular hosts from onboarding', () => {
	expect(mcpClientTabs.map((tab) => tab.id)).toEqual([
		'cursor',
		'codex-chatgpt',
		'claude-desktop',
		'claude-code',
		'opencode',
		'vscode',
		'other',
	])
	expect(
		mcpClientTabs.filter((tab) => tab.isNonCodingAgent).map((tab) => tab.id),
	).toEqual(['codex-chatgpt', 'claude-desktop'])
	expect(nonCodingAgentNote).toMatch(/coding agent/i)
})

test('Cursor JSON uses mcpServers with a remote url', () => {
	expect(JSON.parse(buildCursorMcpJson(mcpServerUrl))).toEqual({
		mcpServers: {
			kody: {
				url: mcpServerUrl,
			},
		},
	})
})

test('Claude Code JSON requires type http for remote servers', () => {
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
})

test('VS Code JSON uses servers root key with type http', () => {
	expect(JSON.parse(buildVsCodeMcpJson(mcpServerUrl))).toEqual({
		servers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
})

test('OpenCode JSON uses mcp remote type', () => {
	expect(JSON.parse(buildOpenCodeMcpJson(mcpServerUrl))).toEqual({
		mcp: {
			kody: {
				type: 'remote',
				url: mcpServerUrl,
				enabled: true,
			},
		},
	})
})

test('Codex TOML is a streamable HTTP mcp_servers entry', () => {
	expect(buildCodexMcpToml(mcpServerUrl)).toBe(
		['[mcp_servers.kody]', `url = "${mcpServerUrl}"`, ''].join('\n'),
	)
})
