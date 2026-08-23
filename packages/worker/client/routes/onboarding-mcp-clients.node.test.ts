import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
	buildCursorMcpMergeCommand,
	buildKodyAppIconUrl,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	codexMcpLoginCommand,
	mcpClientTabs,
	mergeCursorUserMcpConfig,
	openCodeMcpAuthCommand,
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
		'copilot',
		'copilot-app',
		'other',
	])
	expect(
		mcpClientTabs.filter((tab) => tab.isNonCodingAgent).map((tab) => tab.id),
	).toEqual(['chatgpt', 'claude-desktop', 'grok', 'copilot-app'])
	expect(mcpClientTabs.find((tab) => tab.id === 'copilot')?.label).toBe(
		'Copilot',
	)
	expect(mcpClientTabs.find((tab) => tab.id === 'copilot-app')?.label).toBe(
		'Copilot App',
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

	expect(mergeCursorUserMcpConfig(null, mcpServerUrl)).toEqual({
		mcpServers: { kody: { url: mcpServerUrl } },
	})
	expect(
		mergeCursorUserMcpConfig(
			{
				mcpServers: {
					other: { command: 'npx' },
					kody: { url: 'https://old.example/mcp', headers: { X: '1' } },
				},
				theme: 'dark',
			},
			mcpServerUrl,
		),
	).toEqual({
		mcpServers: {
			other: { command: 'npx' },
			kody: { url: mcpServerUrl },
		},
		theme: 'dark',
	})
	expect(() => mergeCursorUserMcpConfig([], mcpServerUrl)).toThrow(
		/must be a JSON object/u,
	)
	expect(() =>
		mergeCursorUserMcpConfig({ mcpServers: [] }, mcpServerUrl),
	).toThrow(/mcpServers must be an object/u)

	const cursorCommand = buildCursorMcpMergeCommand(mcpServerUrl)
	expect(cursorCommand).toContain(mcpServerUrl)
	expect(cursorCommand).toContain("node <<'EOF'")
	expect(cursorCommand).not.toMatch(/cursor mcp add|agent mcp add/u)

	const home = mkdtempSync(join(tmpdir(), 'kody-cursor-mcp-'))
	execSync(cursorCommand, {
		env: { ...process.env, HOME: home },
		shell: '/bin/bash',
	})
	expect(
		JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')),
	).toEqual({
		mcpServers: { kody: { url: mcpServerUrl } },
	})

	mkdirSync(join(home, 'existing', '.cursor'), { recursive: true })
	const existingHome = join(home, 'existing')
	writeFileSync(
		join(existingHome, '.cursor', 'mcp.json'),
		JSON.stringify(
			{
				mcpServers: { notes: { command: 'notes' } },
				extra: true,
			},
			null,
			2,
		),
	)
	execSync(buildCursorMcpMergeCommand(mcpServerUrl), {
		env: { ...process.env, HOME: existingHome },
		shell: '/bin/bash',
	})
	expect(
		JSON.parse(readFileSync(join(existingHome, '.cursor', 'mcp.json'), 'utf8')),
	).toEqual({
		mcpServers: {
			notes: { command: 'notes' },
			kody: { url: mcpServerUrl },
		},
		extra: true,
	})

	const invalidHome = join(home, 'invalid')
	mkdirSync(join(invalidHome, '.cursor'), { recursive: true })
	writeFileSync(join(invalidHome, '.cursor', 'mcp.json'), '{not-json')
	expect(() =>
		execSync(buildCursorMcpMergeCommand(mcpServerUrl), {
			env: { ...process.env, HOME: invalidHome },
			shell: '/bin/bash',
			stdio: 'pipe',
		}),
	).toThrow()
	expect(readFileSync(join(invalidHome, '.cursor', 'mcp.json'), 'utf8')).toBe(
		'{not-json',
	)
})
