import { expect, test } from 'vitest'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { computeClaudeWidgetDomain } from '#mcp/apps/claude-widget-domain.ts'
import { renderGeneratedUiShellEntryPoint } from '#mcp/apps/generated-ui-shell-entry-point.ts'

const mcpResourcePath = '/mcp'

/**
 * Full MCP E2E cannot assert APP_BASE_URL that differs from the Streamable HTTP
 * server URL: @modelcontextprotocol/sdk OAuth rejects protected-resource metadata
 * when `resource` does not match the MCP endpoint origin (see `selectResourceURL`
 * in client/auth.js). Production uses the same public origin for both.
 */
test('canonical APP_BASE_URL drives shell script href and MCP URL for widget domain', async () => {
	const appBase = getAppBaseUrl({
		env: { APP_BASE_URL: 'https://heykody.dev/custom-path' },
		requestUrl: 'http://127.0.0.1:9999/mcp',
	})
	expect(appBase).toBe('https://heykody.dev')

	const html = renderGeneratedUiShellEntryPoint(appBase)
	expect(html).toContain('https://heykody.dev/mcp-apps/generated-ui-shell.js')

	const mcpServerUrl = new URL(mcpResourcePath, appBase).toString()
	expect(mcpServerUrl).toBe('https://heykody.dev/mcp')
	expect(await computeClaudeWidgetDomain(mcpServerUrl)).toBe(
		await computeClaudeWidgetDomain('https://heykody.dev/mcp'),
	)
})
