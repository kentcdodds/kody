import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import {
	buildClaudeCodeAddCommand,
	buildCodexMcpAddCommand,
	defaultKodyMcpUrl,
	grokBotInstallUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
} from './onboarding-mcp-clients.ts'

test('onboarding Step 1 starts with one-agent picker and hides other hosts', async () => {
	const html = await renderToString(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl: defaultKodyMcpUrl }),
	)

	expect(html).toContain('data-testid="onboarding-agent-picker"')
	expect(html).toContain('data-testid="onboarding-agent-cursor"')
	expect(html).toContain('href="/onboarding?agent=cursor&amp;surface=desktop"')
	expect(html).toContain('data-testid="onboarding-agent-other"')
	expect(html).toContain('Not listed')
	expect(html).not.toContain('data-testid="onboarding-mcp-automatic"')
	expect(html).not.toContain('npx @kodycodes/cli install')
	expect(html).not.toContain(kodyCursorMarketplaceUrl)
	expect(html).not.toContain(buildClaudeCodeAddCommand(defaultKodyMcpUrl))
	expect(html).not.toContain('data-testid="onboarding-authenticate-callout"')
	expect(html).toContain('data-testid="onboarding-agent-grok-bot"')
	expect(html).toContain('href="/onboarding?agent=grok-bot&amp;surface=desktop"')
	expect(html).toContain('href="/onboarding?agent=grok-bot&amp;surface=mobile"')
	expect(html).not.toContain(
		'href="/onboarding?agent=grok-cli&amp;surface=desktop"',
	)
	expect(html).not.toContain('href="/onboarding?agent=grok&amp;surface=mobile"')
})

test('onboarding Step 1 shows only the selected agent instructions', async () => {
	const html = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'cursor',
		}),
	)

	expect(html).toContain('data-testid="onboarding-agent-instructions"')
	expect(html).toContain('data-agent="cursor"')
	expect(html).toContain('data-testid="onboarding-agent-change"')
	expect(html).toContain('Change selection')
	expect(html).toContain(kodyCursorMarketplaceUrl)
	expect(html).toContain(kodyCursorAddPluginCommand)
	expect(html).toContain('data-testid="onboarding-authenticate-callout"')
	expect(html).toContain('Cursor MCP list')
	expect(html).not.toContain(buildClaudeCodeAddCommand(defaultKodyMcpUrl))
	expect(html).not.toContain(grokBotInstallUrl)
	expect(html).not.toContain('npx @kodycodes/cli install')
	expect(html).not.toContain('Claude Code:')

	const pluginBlocks = [
		...html.matchAll(
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
})

test('onboarding Step 1 Not listed offers remaining hosts and the MCP URL', async () => {
	const html = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'other',
		}),
	)

	expect(html).toContain(defaultKodyMcpUrl)
	expect(html).toContain('These hosts have their own steps')
	expect(html).toContain('data-testid="onboarding-agent-grok-cli"')
	expect(html).toContain('data-testid="onboarding-agent-chatgpt"')
	expect(html).not.toContain('data-testid="onboarding-agent-grok-bot"')
	expect(html).not.toContain(grokBotInstallUrl)
	expect(html).not.toContain(buildCodexMcpAddCommand(defaultKodyMcpUrl))
})

test('onboarding Step 1 selected host uses this deployment MCP URL', async () => {
	const previewUrl = 'http://localhost:3742/mcp'
	const html = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: previewUrl,
			selectedAgent: 'codex',
		}),
	)

	expect(html).toContain(buildCodexMcpAddCommand(previewUrl))
	expect(html).toContain('codex mcp login kody')
	expect(html).not.toContain(kodyCursorMarketplaceUrl)
})

test('onboarding Step 1 Grok Bot instructions change for phone vs desktop', async () => {
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
	expect(desktop).toContain('Add to Grok Bot')
	expect(desktop).toContain('Grok Bot sidebar')
	expect(desktop).not.toContain('On your phone')
	expect(desktop).not.toContain('grok mcp add')

	expect(mobile).toContain('data-surface="mobile"')
	expect(mobile).toContain(grokBotInstallUrl)
	expect(mobile).toContain('On your phone')
	expect(mobile).toContain('tap')
	expect(mobile).toContain('not grok.com')
	expect(mobile).toContain('on your phone or on a computer')
	expect(mobile).not.toContain('Grok Bot sidebar')
	expect(mobile).not.toContain('grok mcp add')
})
