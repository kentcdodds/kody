import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import {
	buildClaudeCodeAddCommand,
	buildCodexMcpAddCommand,
	buildCopilotCliAddCommand,
	buildCursorInstallUrl,
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
	expect(manualBlock).toContain('~/.cursor/mcp.json')
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
	expect(manualBlock).toContain(
		buildCursorInstallUrl(defaultKodyMcpUrl).replaceAll('&', '&amp;'),
	)
	expect(manualBlock).toContain('data-testid="onboarding-mcp-cursor-fallback"')
	expect(manualBlock).toContain(
		'data-testid="onboarding-mcp-grok-bot-fallback"',
	)
	expect(manualBlock).not.toMatch(
		/<details[^>]*\bopen\b[^>]*data-testid="onboarding-mcp-cursor-fallback"/,
	)
	expect(manualBlock).toContain(
		'https://cursor.com/help/grok-bot/connect-plugins',
	)

	const previewHtml = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: 'http://localhost:3742/mcp',
		}),
	)
	expect(previewHtml).toContain(
		'npx @kodycodes/cli install --mcp-url http://localhost:3742/mcp',
	)
	expect(previewHtml).toContain(
		'This origin is not production <code>kody.codes</code>',
	)
	expect(previewHtml).toMatch(
		/<details[^>]*\bopen\b[^>]*data-testid="onboarding-mcp-cursor-fallback"|<details[^>]*data-testid="onboarding-mcp-cursor-fallback"[^>]*\bopen\b/,
	)
})
