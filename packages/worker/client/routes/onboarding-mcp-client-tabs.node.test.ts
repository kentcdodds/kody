import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { OnboardingMcpClientTabs } from './onboarding-mcp-client-tabs.tsx'
import {
	buildClaudeCodeAddCommand,
	buildCodexMcpAddCommand,
	buildCopilotCliAddCommand,
	buildOpenCodeMcpAddCommand,
} from './onboarding-mcp-clients.ts'

const mcpServerUrl = 'https://heykody.dev/mcp'

test('onboarding MCP tabs show Automatic first and collapse Manual', async () => {
	const html = await renderToString(
		jsx(OnboardingMcpClientTabs, { mcpServerUrl }),
	)

	expect(html).toContain('data-testid="onboarding-mcp-automatic"')
	expect(html).toMatch(
		/<details(?![^>]*\bopen\b)[^>]*data-testid="onboarding-mcp-manual"/,
	)
	expect(html).toContain('>Automatic<')
	expect(html).toContain('>Manual<')
	expect(html).toMatch(/aria-selected="true"[^>]*>Cursor</)

	expect(html).toContain(mcpServerUrl)
	expect(html).toContain('~/.cursor/mcp.json')
	expect(html).toContain(buildClaudeCodeAddCommand(mcpServerUrl))
	expect(html).toContain(buildCodexMcpAddCommand(mcpServerUrl))
	expect(html).toContain(buildOpenCodeMcpAddCommand(mcpServerUrl))
	expect(html).toContain(buildCopilotCliAddCommand(mcpServerUrl))
	expect(html).toContain('Add to Cursor')
	expect(html).toContain('Add to VS Code')
})
