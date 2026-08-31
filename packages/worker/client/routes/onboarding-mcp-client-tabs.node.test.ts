import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import {
	buildClaudeCodeAddCommand,
	buildCodexMcpAddCommand,
	buildOpenClawMcpAddCommand,
	defaultKodyMcpUrl,
	grokBotInstallUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
} from './onboarding-mcp-clients.ts'

test('onboarding Step 1 picker selects an agent, then Not listed, and flips Grok Bot surfaces', async () => {
	const picker = await renderToString(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl: defaultKodyMcpUrl }),
	)
	expect(picker).toContain('data-testid="onboarding-agent-picker"')
	expect(picker).toContain('data-testid="onboarding-agent-cursor"')
	expect(picker).toContain(
		'href="/onboarding?agent=cursor&amp;surface=desktop"',
	)
	expect(picker).toContain('data-testid="onboarding-agent-other"')
	expect(picker).toContain('data-testid="onboarding-agent-grok-bot"')
	expect(picker).toContain('data-testid="onboarding-agent-openclaw"')
	expect(picker).toContain(
		'href="/onboarding?agent=openclaw&amp;surface=desktop"',
	)
	expect(picker).toContain(
		'href="/onboarding?agent=chatgpt&amp;surface=desktop"',
	)
	expect(picker).toContain(
		'href="/onboarding?agent=claude-desktop&amp;surface=desktop"',
	)
	expect(picker).toContain(
		'href="/onboarding?agent=gemini&amp;surface=desktop"',
	)
	expect(picker).not.toContain('data-testid="onboarding-agent-instructions"')
	expect(picker).not.toContain(buildClaudeCodeAddCommand(defaultKodyMcpUrl))
	expect(picker).not.toContain(
		'href="/onboarding?agent=grok-cli&amp;surface=desktop"',
	)
	expect(picker).not.toContain(
		'href="/onboarding?agent=grok&amp;surface=desktop"',
	)
	expect(picker).not.toContain(
		'href="/onboarding?agent=copilot-app&amp;surface=desktop"',
	)
	expect(picker).toContain('/images/icons/cursor.svg')
	expect(picker).toContain('/images/icons/grokbot.svg')

	const cursor = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'cursor',
		}),
	)
	expect(cursor).toContain('data-testid="onboarding-agent-instructions"')
	expect(cursor).toContain('data-agent="cursor"')
	expect(cursor).toContain('data-testid="onboarding-agent-change"')
	expect(cursor).toContain(kodyCursorMarketplaceUrl)
	expect(cursor).toContain(kodyCursorAddPluginCommand)
	expect(cursor).toContain('data-testid="onboarding-authenticate-callout"')
	expect(cursor).not.toContain(buildClaudeCodeAddCommand(defaultKodyMcpUrl))
	expect(cursor).not.toContain(grokBotInstallUrl)
	const pluginBlocks = [
		...cursor.matchAll(
			/<div data-testid="onboarding-mcp-plugin-primary"[\s\S]*?<\/small><\/div>/g,
		),
	].map((match) => match[0])
	expect(pluginBlocks).toHaveLength(1)
	const [cursorPrimary] = pluginBlocks
	expect(
		cursorPrimary.indexOf(`href="${kodyCursorMarketplaceUrl}"`),
	).toBeLessThan(cursorPrimary.indexOf('onboarding-mcp-plugin-alternative'))
	expect(
		cursorPrimary.indexOf('onboarding-mcp-plugin-alternative'),
	).toBeLessThan(cursorPrimary.indexOf(kodyCursorAddPluginCommand))

	const other = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'other',
		}),
	)
	expect(other).toContain(defaultKodyMcpUrl)
	expect(other).toContain('data-testid="onboarding-agent-grok-cli"')
	expect(other).toContain('data-testid="onboarding-agent-grok"')
	expect(other).toContain('data-testid="onboarding-agent-copilot-app"')
	expect(other).not.toContain('data-testid="onboarding-agent-chatgpt"')
	expect(other).not.toContain('data-testid="onboarding-agent-claude-desktop"')
	expect(other).not.toContain('data-testid="onboarding-agent-gemini"')
	expect(other).not.toContain('data-testid="onboarding-agent-grok-bot"')
	expect(other).not.toContain(grokBotInstallUrl)
	expect(other).not.toContain(buildCodexMcpAddCommand(defaultKodyMcpUrl))

	const previewUrl = 'http://localhost:3742/mcp'
	const codexPreview = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: previewUrl,
			selectedAgent: 'codex',
		}),
	)
	expect(codexPreview).toContain(buildCodexMcpAddCommand(previewUrl))
	expect(codexPreview).not.toContain(kodyCursorMarketplaceUrl)

	const desktop = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'grok-bot',
			surface: 'desktop',
		}),
	)
	const mobile = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'grok-bot',
			surface: 'mobile',
		}),
	)
	expect(desktop).toContain('data-agent="grok-bot"')
	expect(desktop).toContain('data-surface="desktop"')
	expect(desktop).toContain(grokBotInstallUrl)
	expect(desktop).not.toContain('data-surface="mobile"')
	expect(mobile).toContain('data-surface="mobile"')
	expect(mobile).toContain(grokBotInstallUrl)
	expect(mobile).not.toContain('data-surface="desktop"')

	const openclaw = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'openclaw',
		}),
	)
	expect(openclaw).toContain('data-agent="openclaw"')
	expect(openclaw).toContain(buildOpenClawMcpAddCommand(defaultKodyMcpUrl))
	expect(openclaw).toContain('openclaw mcp login kody')
	expect(openclaw).toContain('openclaw mcp doctor kody --probe')
	expect(openclaw).not.toContain('on a computer')

	const openclawMobile = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'openclaw',
			surface: 'mobile',
		}),
	)
	expect(openclawMobile).toContain('data-surface="mobile"')
	expect(openclawMobile).toContain('openclaw mcp login kody')
	expect(openclawMobile).toContain('on a computer')
})
