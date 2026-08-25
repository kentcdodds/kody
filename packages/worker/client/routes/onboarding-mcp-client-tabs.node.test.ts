import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import {
	buildClaudeCodeAddCommand,
	buildCodexMcpAddCommand,
	buildCopilotCliAddCommand,
	buildKodyCliInstallCommand,
	buildOpenCodeMcpAddCommand,
	defaultKodyMcpUrl,
	grokBotInstallUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
} from './onboarding-mcp-clients.ts'

test('onboarding Step 1 shows @kodycodes/cli first and collapses Manual', async () => {
	const html = await renderToString(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl: defaultKodyMcpUrl }),
	)

	expect(html).toContain('data-testid="onboarding-mcp-automatic"')
	expect(html).toMatch(
		/<details(?![^>]*\bopen\b)[^>]*data-testid="onboarding-mcp-manual"/,
	)
	expect(html).toContain('npx @kodycodes/cli install')
	expect(html).not.toContain('--mcp-url')
	expect(html).toMatch(/aria-selected="true"[^>]*>Cursor</)

	const automaticBlock = html.slice(
		html.indexOf('data-testid="onboarding-mcp-automatic"'),
		html.indexOf('data-testid="onboarding-mcp-manual"'),
	)
	expect(automaticBlock).toContain(
		buildKodyCliInstallCommand(defaultKodyMcpUrl),
	)
	expect(automaticBlock).toContain(
		'You can also manually connect web hosts such as ChatGPT, Claude.ai, and Grok below.',
	)
	expect(automaticBlock).toContain('Codex / ChatGPT desktop')
	expect(automaticBlock).not.toContain('stay under Manual')
	expect(automaticBlock).not.toContain('Add to Cursor')
	expect(automaticBlock).not.toContain('Choose your client')

	const manualBlock = html.slice(
		html.indexOf('data-testid="onboarding-mcp-manual"'),
	)
	expect(manualBlock).toContain('Choose your client')
	expect(manualBlock).toContain(defaultKodyMcpUrl)
	expect(manualBlock).toContain(buildClaudeCodeAddCommand(defaultKodyMcpUrl))
	expect(manualBlock).toContain(buildCodexMcpAddCommand(defaultKodyMcpUrl))
	expect(manualBlock).toContain(buildOpenCodeMcpAddCommand(defaultKodyMcpUrl))
	expect(manualBlock).toContain(buildCopilotCliAddCommand(defaultKodyMcpUrl))
	expect(manualBlock).toContain('Add to Cursor')
	expect(manualBlock).toContain('Add to VS Code')
	expect(manualBlock).toContain('Add to Grok Bot')
	expect(manualBlock).toContain('chatgpt.com')
	expect(manualBlock).toContain('>Grok Bot<')
	expect(manualBlock).toContain(kodyCursorMarketplaceUrl)
	expect(manualBlock).toContain(kodyCursorAddPluginCommand)
	expect(manualBlock).toContain(grokBotInstallUrl)
	expect(manualBlock).toContain('Or do this:')
	expect(manualBlock).toContain('data-testid="onboarding-mcp-plugin-primary"')
	expect(manualBlock).toContain(
		'data-testid="onboarding-mcp-plugin-alternative"',
	)
	expect(manualBlock).not.toContain('Cursor&apos;s')
	expect(manualBlock).not.toContain("Cursor's")
	expect(manualBlock).not.toContain('~/.cursor/mcp.json')
	expect(manualBlock).not.toContain('cursor://anysphere.cursor-deeplink')
	expect(manualBlock).not.toContain('onboarding-mcp-cursor-fallback')
	expect(manualBlock).not.toContain('onboarding-mcp-grok-bot-fallback')
	expect(manualBlock).not.toContain('This origin is not production')
	expect(manualBlock).not.toContain('targets production')
	expect(manualBlock).toContain('>Grok Bot plugin help<')
	expect(manualBlock).toContain(
		'https://cursor.com/help/grok-bot/connect-plugins',
	)

	const pluginBlocks = [
		...manualBlock.matchAll(
			/<div data-testid="onboarding-mcp-plugin-primary"[\s\S]*?<\/small><\/div>/g,
		),
	].map((match) => match[0])
	expect(pluginBlocks).toHaveLength(2)
	const [cursorPrimary, grokBotPrimary] = pluginBlocks
	expect(
		cursorPrimary.indexOf(`href="${kodyCursorMarketplaceUrl}"`),
	).toBeLessThan(cursorPrimary.indexOf('onboarding-mcp-plugin-alternative'))
	expect(
		cursorPrimary.indexOf('onboarding-mcp-plugin-alternative'),
	).toBeLessThan(cursorPrimary.indexOf(kodyCursorAddPluginCommand))
	expect(cursorPrimary).not.toContain('Copy command')
	expect(cursorPrimary).not.toContain('Manual / fallback')
	expect(grokBotPrimary.indexOf(`href="${grokBotInstallUrl}"`)).toBeLessThan(
		grokBotPrimary.indexOf('onboarding-mcp-plugin-alternative'),
	)
	expect(grokBotPrimary).not.toContain('Copy link')
	expect(grokBotPrimary).not.toContain('Manual / fallback')

	const previewHtml = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: 'http://localhost:3742/mcp',
		}),
	)
	expect(previewHtml).toContain(
		'npx @kodycodes/cli install --mcp-url http://localhost:3742/mcp',
	)
	expect(previewHtml).toContain(kodyCursorMarketplaceUrl)
	expect(previewHtml).toContain(grokBotInstallUrl)
	expect(previewHtml).not.toContain('This origin is not production')
	expect(previewHtml).not.toContain('onboarding-mcp-cursor-fallback')
	expect(previewHtml).not.toContain('onboarding-mcp-grok-bot-fallback')
	expect(previewHtml).not.toContain('cursor://anysphere.cursor-deeplink')
})
