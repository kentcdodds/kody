import type * as SentryCloudflare from '@sentry/cloudflare'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, test, vi } from 'vitest'

const sentryMock = vi.hoisted(() => ({
	wrapMcpServerWithSentry: vi.fn((server: unknown) => server),
}))

vi.mock('@sentry/cloudflare', async (importOriginal) => {
	const actual = await importOriginal<typeof SentryCloudflare>()
	return {
		...actual,
		wrapMcpServerWithSentry: sentryMock.wrapMcpServerWithSentry,
	}
})

test('createKodyMcpServer applies Sentry MCP instrumentation without payload recording', async () => {
	const { createKodyMcpServer } = await import('./sentry-mcp-server.ts')

	const server = createKodyMcpServer({
		instructions: 'test instructions',
	})

	expect(server).toBeDefined()
	expect(sentryMock.wrapMcpServerWithSentry).toHaveBeenCalledTimes(1)
	expect(sentryMock.wrapMcpServerWithSentry).toHaveBeenCalledWith(
		expect.any(McpServer),
		{
			recordInputs: false,
			recordOutputs: false,
		},
	)
})
