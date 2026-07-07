import { expect, test } from 'vitest'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { computeClaudeWidgetDomain } from '#mcp/apps/claude-widget-domain.ts'
import { renderGeneratedUiRuntimeHtmlEntry } from '#mcp/apps/generated-ui-runtime-html-entry.ts'

const mcpResourcePath = '/mcp'

/**
 * Full MCP E2E cannot assert a canonical origin that differs from the
 * Streamable HTTP server URL: @modelcontextprotocol/sdk OAuth rejects
 * protected-resource metadata when `resource` does not match the MCP endpoint
 * origin (see `selectResourceURL` in client/auth.js). Request-origin resolution
 * keeps metadata aligned with the host the client connected to.
 */
test('request origin drives runtime script href and MCP URL for widget domain', async () => {
	const appBase = getAppBaseUrl({
		env: { APP_BASE_URL: 'https://configured.example' },
		requestUrl: 'https://heykody.dev/mcp',
	})
	expect(appBase).toBe('https://heykody.dev')

	const html = renderGeneratedUiRuntimeHtmlEntry(appBase)
	expect(html).toMatch(/https:\/\/heykody\.dev\/mcp-apps\/[^"]+/)
	expect(html).not.toContain('configured.example')

	const mcpServerUrl = new URL(mcpResourcePath, appBase).toString()
	expect(mcpServerUrl).toBe('https://heykody.dev/mcp')
	expect(await computeClaudeWidgetDomain(mcpServerUrl)).toBe(
		await computeClaudeWidgetDomain('https://heykody.dev/mcp'),
	)
})
