import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpAddCommand,
	buildCodexMcpToml,
	buildCopilotCliAddCommand,
	buildCopilotCliMcpJson,
	buildGrokCliAddCommand,
	buildGrokCliMcpToml,
	buildOpenClawMcpAddCommand,
	buildOpenClawMcpJson,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildVsCodeMcpJson,
	chatGptDeveloperModeGuideUrl,
	cursorMcpGuideUrl,
	defaultKodyMcpUrl,
	grokBotConnectPluginsUrl,
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
	expect(picker).toContain('href="/onboarding/step-1/cursor"')
	expect(picker).toContain('data-testid="onboarding-agent-other"')
	expect(picker).toContain('href="/onboarding/step-1/not-listed"')
	const pickerRedirect = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			search: '?redirectTo=%2F',
		}),
	)
	expect(pickerRedirect).toContain(
		'href="/onboarding/step-1/cursor?redirectTo=%2F"',
	)
	expect(pickerRedirect).toContain(
		'href="/onboarding/step-1/not-listed?redirectTo=%2F"',
	)
	expect(picker).toContain('data-testid="onboarding-agent-grok-bot"')
	expect(picker).toContain('data-testid="onboarding-agent-openclaw"')
	expect(picker).toContain('href="/onboarding/step-1/openclaw"')
	expect(picker).toContain('href="/onboarding/step-1/chatgpt"')
	expect(picker).toContain('href="/onboarding/step-1/claude-desktop"')
	expect(picker).toContain('href="/onboarding/step-1/gemini"')
	expect(picker).toContain('data-testid="onboarding-agent-copilot-app"')
	expect(picker).not.toContain('data-testid="onboarding-agent-instructions"')
	expect(picker).not.toContain(buildClaudeCodeAddCommand(defaultKodyMcpUrl))
	expect(picker).not.toContain('href="/onboarding/step-1/grok-cli"')
	expect(picker).toContain('href="/onboarding/step-1/grok"')
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
	expect(cursor).not.toContain('data-testid="onboarding-agent-change"')
	expect(cursor).toContain(kodyCursorMarketplaceUrl)
	expect(cursor).toContain(kodyCursorAddPluginCommand)
	expect(cursor).toContain('data-testid="onboarding-authenticate-callout"')
	expect(cursor).toContain('data-testid="onboarding-agent-help"')
	expect(cursor).toContain(cursorMcpGuideUrl)
	expect(cursor).not.toContain(buildClaudeCodeAddCommand(defaultKodyMcpUrl))
	expect(cursor).not.toContain(grokBotInstallUrl)
	const pluginBlocks = [
		...cursor.matchAll(
			/<div data-testid="onboarding-mcp-plugin-primary"[\s\S]*?<\/small><\/div>/g,
		),
	].map((match) => match[0])
	expect(pluginBlocks.length).toBeGreaterThanOrEqual(1)
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
	expect(other).toContain('data-testid="onboarding-agent-not-listed"')
	expect(other).toContain('id="onboarding-agent-not-listed-label"')
	expect(other).toContain("Any of these what you're looking for?")
	expect(other).toContain('Or, connect any agent that speaks MCP')
	expect(other).toContain(defaultKodyMcpUrl)
	expect(other).toContain('data-testid="onboarding-agent-copilot-app"')
	expect(other).toContain('data-testid="onboarding-agent-codex"')
	expect(other).toContain('data-testid="onboarding-agent-claude-code"')
	expect(other).not.toContain('data-testid="onboarding-agent-grok-cli"')
	expect(other).toContain('data-testid="onboarding-agent-grok"')
	expect(other).toContain('data-testid="onboarding-agent-cursor"')
	expect(other).toContain('data-testid="onboarding-agent-devin"')
	expect(other).not.toContain(grokBotInstallUrl)

	const previewUrl = 'http://localhost:3742/mcp'
	const codexPreview = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: previewUrl,
			selectedAgent: 'codex',
		}),
	)
	expect(codexPreview).toContain(buildCodexMcpAddCommand(previewUrl))
	expect(codexPreview).not.toContain(kodyCursorMarketplaceUrl)

	const grokBot = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'grok-bot',
		}),
	)
	expect(grokBot).toContain('data-agent="grok-bot"')
	expect(grokBot).toContain('data-surface="desktop"')
	expect(grokBot).toContain('data-surface="mobile"')
	expect(grokBot).toContain(grokBotInstallUrl)
	expect(grokBot).toContain('data-testid="onboarding-agent-help"')
	expect(grokBot).toContain(grokBotConnectPluginsUrl)
	expect(grokBot).toContain('Plugins')
	expect(grokBot).not.toContain('Click Add to Grok Bot')
	expect(grokBot).not.toContain('Install the official Kody plugin')
	expect(grokBot).not.toContain('onboarding-mcp-plugin-alternative')
	expect(grokBot.indexOf('onboarding-mcp-plugin-primary')).toBeLessThan(
		grokBot.indexOf('Or add Kody from'),
	)

	const openclaw = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'openclaw',
		}),
	)
	expect(openclaw).toContain('data-agent="openclaw"')
	expect(openclaw).toContain(buildOpenClawMcpAddCommand(defaultKodyMcpUrl))
	expect(openclaw).toContain('openclaw mcp login kody')
	expect(openclaw).not.toContain('openclaw mcp doctor kody --probe')
	expect(openclaw).toContain('data-surface="mobile"')
	expect(openclaw).toContain('on a computer')

	const chatgpt = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'chatgpt',
		}),
	)
	expect(chatgpt).toContain('data-testid="onboarding-mcp-app-icon"')
	expect(chatgpt).toContain('src="https://kody.codes/images/kody-app-icon.png"')
	expect(chatgpt).toContain('alt="Kody app icon"')
	expect(chatgpt).toContain('download="kody-app-icon.png"')
	expect(chatgpt).toContain('Download App Icon')
	expect(chatgpt).toContain('Right-click the icon')
	expect(chatgpt).not.toContain('Download PNG')
	expect(chatgpt).not.toContain('Copy icon URL')
	expect(chatgpt).not.toContain('>App icon<')
	expect(chatgpt).toContain('data-testid="onboarding-agent-help"')
	expect(chatgpt).toContain(chatGptDeveloperModeGuideUrl)
	expect(chatgpt).toContain('ChatGPT developer mode is required.')
	expect(chatgpt).toContain('>developer mode help<')
	expect(chatgpt).not.toContain('>ChatGPT developer mode help<')
	expect(chatgpt).toContain('data-testid="onboarding-agent-warning"')
	expect(chatgpt).toContain('ChatGPT desktop is Codex')

	const codexMobile = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: defaultKodyMcpUrl,
			selectedAgent: 'codex',
			surface: 'mobile',
		}),
	)
	expect(codexMobile).toContain('data-testid="onboarding-mcp-app-icon"')
	expect(codexMobile).toContain(
		'src="https://kody.codes/images/kody-app-icon.png"',
	)
	expect(codexMobile).toContain('download="kody-app-icon.png"')
	expect(codexMobile).toContain('Download App Icon')
	expect(codexMobile).not.toContain('Download PNG')
	expect(codexMobile).not.toContain('Copy icon URL')
	expect(codexMobile).not.toContain('>App icon<')
})

const closedManualDetails =
	/<details(?![^>]*\bopen\b)[^>]*data-testid="onboarding-mcp-manual-json"/g

function countClosedManualDetails(html: string) {
	return [...html.matchAll(closedManualDetails)].length
}

test('onboarding alternative config wells collapse behind closed details', async () => {
	const url = defaultKodyMcpUrl

	const codex = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'codex',
		}),
	)
	expect(codex).toContain(buildCodexMcpAddCommand(url))
	expect(codex).toContain(buildCodexMcpToml(url))
	expect(codex).toContain('Copy TOML')
	expect(codex).toContain('Or merge this into')
	expect(codex).toContain('>~/.codex/config.toml</code>:')
	expect(countClosedManualDetails(codex)).toBeGreaterThanOrEqual(1)

	const grokCli = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'grok-cli',
		}),
	)
	expect(grokCli).toContain(buildGrokCliAddCommand(url))
	expect(grokCli).toContain(buildGrokCliMcpToml(url))
	expect(grokCli).toContain('>~/.grok/config.toml</code>:')
	expect(countClosedManualDetails(grokCli)).toBeGreaterThanOrEqual(1)

	const claudeCode = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'claude-code',
		}),
	)
	expect(claudeCode).toContain(buildClaudeCodeAddCommand(url))
	expect(claudeCode).toContain(buildClaudeCodeMcpJson(url))
	expect(claudeCode).toContain('Copy JSON')
	expect(claudeCode).toContain('Or merge this into a project')
	expect(claudeCode).toContain('>.mcp.json</code>:')
	expect(countClosedManualDetails(claudeCode)).toBeGreaterThanOrEqual(1)

	const opencode = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'opencode',
		}),
	)
	expect(opencode).toContain(buildOpenCodeMcpAddCommand(url))
	expect(opencode).toContain(buildOpenCodeMcpJson(url))
	expect(opencode).toContain('Or add this to')
	expect(opencode).toContain('>opencode.json</code>:')
	expect(countClosedManualDetails(opencode)).toBeGreaterThanOrEqual(1)

	const openclaw = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'openclaw',
		}),
	)
	expect(openclaw).toContain(buildOpenClawMcpAddCommand(url))
	expect(openclaw).toContain(buildOpenClawMcpJson(url))
	expect(openclaw).toContain('>~/.openclaw/openclaw.json</code>:')
	expect(countClosedManualDetails(openclaw)).toBeGreaterThanOrEqual(1)

	const copilot = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'copilot',
		}),
	)
	expect(copilot).toContain(buildCopilotCliAddCommand(url))
	expect(copilot).toContain('Or run this for Copilot CLI:')
	expect(copilot).not.toMatch(/<details[\s\S]*Or run this for Copilot CLI/)
	expect(copilot).toContain(buildVsCodeMcpJson(url))
	expect(copilot).toContain(buildCopilotCliMcpJson(url))
	expect(copilot).toContain('>.vscode/mcp.json</code>:')
	expect(copilot).toContain('>~/.copilot/mcp-config.json</code>:')
	expect(countClosedManualDetails(copilot)).toBeGreaterThanOrEqual(2)

	const copilotApp = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'copilot-app',
		}),
	)
	expect(copilotApp).toContain(buildCopilotCliMcpJson(url))
	expect(copilotApp).toContain('>~/.copilot/mcp-config.json</code>:')
	expect(countClosedManualDetails(copilotApp)).toBeGreaterThanOrEqual(1)
})
