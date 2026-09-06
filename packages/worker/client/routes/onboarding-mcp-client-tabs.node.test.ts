import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import {
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
	expect(picker).not.toContain(
		`claude mcp add --transport http -s user kody ${defaultKodyMcpUrl}`,
	)
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
	expect(cursor).not.toContain(
		`claude mcp add --transport http -s user kody ${defaultKodyMcpUrl}`,
	)
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
	expect(codexPreview).toContain(`codex mcp add kody --url ${previewUrl}`)
	expect(codexPreview).toContain(
		`href="codex://mcp/add?name=kody&amp;url=${encodeURIComponent(previewUrl)}"`,
	)
	expect(codexPreview).toContain('>Open Codex<')
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
	expect(openclaw).toContain('openclaw mcp login kody')
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
	expect(chatgpt).toContain('data-testid="onboarding-agent-help"')
	expect(chatgpt).toContain(chatGptDeveloperModeGuideUrl)
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
})

const closedManualDetails =
	/<details(?![^>]*\bopen\b)[^>]*data-testid="onboarding-mcp-manual-json"/g

function countClosedManualDetails(html: string) {
	return [...html.matchAll(closedManualDetails)].length
}

test('onboarding alternative config wells collapse behind closed details', async () => {
	const url = defaultKodyMcpUrl
	const agentsWithClosedWells = [
		'codex',
		'grok-cli',
		'claude-code',
		'opencode',
		'openclaw',
		'copilot-app',
	] as const
	for (const selectedAgent of agentsWithClosedWells) {
		const html = await renderToString(
			jsx(OnboardingMcpClientTabs, {
				mcpServerUrl: url,
				selectedAgent,
			}),
		)
		expect(countClosedManualDetails(html)).toBeGreaterThanOrEqual(1)
	}

	const copilot = await renderToString(
		jsx(OnboardingMcpClientTabs, {
			mcpServerUrl: url,
			selectedAgent: 'copilot',
		}),
	)
	expect(countClosedManualDetails(copilot)).toBeGreaterThanOrEqual(2)
	expect(copilot).not.toMatch(/<details[\s\S]*Or run this for Copilot CLI/)
})
