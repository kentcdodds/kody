import { expect, test } from 'vitest'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createMcpClient,
	createTestDatabase,
	startDevServer,
} from '../../../../tools/mcp-test-support.ts'

/**
 * MCP E2E is intentionally tiny.
 *
 * Do not add cases here unless the thing being tested genuinely requires the
 * real MCP HTTP transport, OAuth flow, and package-app session wiring all at
 * once. Most capability behavior belongs in faster node/workers tests beside
 * the implementation. Keep this file to a couple of smoke journeys.
 */

test('mcp endpoint requires OAuth bearer auth', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)

	const response = await fetch(new URL('/mcp', server.origin), {
		headers: {
			Accept: 'application/json, text/event-stream',
		},
	})

	expect(response.status).toBe(401)
	const authenticateHeader = response.headers.get('WWW-Authenticate') ?? ''
	expect(authenticateHeader).toMatch(/^Bearer\s+/)
})

test('authenticated MCP smoke returns same-origin inline UI sessions', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const inlineUiResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			code: '<main><h1>Storage Context</h1></main>',
		},
	})
	const inlineUiStructured = (inlineUiResult as CallToolResult)
		.structuredContent as
		| {
				renderSource?: string
				appSession?: {
					token?: string
					endpoints?: { execute?: string }
				} | null
		  }
		| undefined
	expect(typeof inlineUiStructured?.appSession?.token).toBe('string')
	const executeEndpoint = inlineUiStructured?.appSession?.endpoints?.execute
	expect(typeof executeEndpoint).toBe('string')
	if (typeof executeEndpoint !== 'string') {
		throw new Error('Expected open_generated_ui to return an execute endpoint')
	}
	const executeUrl = new URL(executeEndpoint, server.origin)
	expect(executeUrl.origin).toBe(server.origin)
})
