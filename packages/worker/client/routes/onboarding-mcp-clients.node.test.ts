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
	buildOpenClawMcpAddCommand,
	buildOpenClawMcpJson,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	defaultKodyMcpUrl,
	isDefaultKodyMcpUrl,
	isValidOnboardingAgentChooserPick,
	mcpClientTabs,
	onboardingAgentLabel,
	onboardingDataHref,
	onboardingDesktopFeaturedAgentIds,
	onboardingMobileFeaturedAgentIds,
	onboardingMoreAgentIdsFor,
	pickOnboardingAgentChooser,
	readOnboardingAgentParam,
	writeOnboardingAgentSearch,
} from './onboarding-mcp-clients.ts'

const mcpServerUrl = defaultKodyMcpUrl

test('onboarding MCP client builders emit the structured configs each host expects', () => {
	const tabIds = mcpClientTabs.map((tab) => tab.id)
	expect(new Set(tabIds).size).toBe(tabIds.length)
	expect(onboardingMoreAgentIdsFor('desktop')).not.toContain(
		onboardingDesktopFeaturedAgentIds[0],
	)
	expect(onboardingMoreAgentIdsFor('mobile')).not.toContain(
		onboardingMobileFeaturedAgentIds[0],
	)
	expect(onboardingAgentLabel('chatgpt', 'mobile')).toBe('Codex')
	expect(onboardingAgentLabel('claude-desktop', 'mobile')).toBe('Claude Code')
	expect(onboardingAgentLabel('chatgpt', 'desktop')).toBe('ChatGPT.com')
	const rotated = pickOnboardingAgentChooser(() => 0)
	const identity = pickOnboardingAgentChooser((max) => max - 1)
	expect(isValidOnboardingAgentChooserPick(rotated)).toBe(true)
	expect(rotated.desktopFeatured).not.toEqual(identity.desktopFeatured)
	expect(rotated.mobileFeatured).not.toEqual(identity.mobileFeatured)
	expect(readOnboardingAgentParam('?agent=cursor&redirectTo=%2F')).toBe(
		'cursor',
	)
	expect(readOnboardingAgentParam('?agent=nope')).toBeNull()
	expect(writeOnboardingAgentSearch('?redirectTo=%2F', 'claude-code')).toBe(
		'?redirectTo=%2F&agent=claude-code',
	)
	expect(writeOnboardingAgentSearch('?agent=cursor', null)).toBe('')
	expect(
		writeOnboardingAgentSearch('?redirectTo=%2F', 'chatgpt', 'mobile'),
	).toBe('?redirectTo=%2F&agent=chatgpt&surface=mobile')
	expect(onboardingDataHref('/onboarding?agent=cursor&surface=desktop')).toBe(
		'/onboarding',
	)
	expect(
		onboardingDataHref('/onboarding?agent=cursor&surface=desktop#connect-mcp'),
	).toBe('/onboarding')
	expect(
		mcpClientTabs.filter((tab) => tab.isNonCodingAgent).map((tab) => tab.id),
	).toEqual([
		'chatgpt',
		'claude-desktop',
		'grok',
		'grok-bot',
		'copilot-app',
		'gemini',
	])

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
	expect(buildOpenClawMcpAddCommand(mcpServerUrl)).toBe(
		`openclaw mcp add kody --url ${mcpServerUrl} --transport streamable-http --auth oauth`,
	)
	expect(JSON.parse(buildOpenClawMcpJson(mcpServerUrl))).toEqual({
		mcp: {
			servers: {
				kody: {
					url: mcpServerUrl,
					transport: 'streamable-http',
					auth: 'oauth',
					enabled: true,
				},
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
		'https://kody.codes/images/kody-app-icon.png',
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
