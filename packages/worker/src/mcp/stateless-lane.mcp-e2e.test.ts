import { expect, test } from 'vitest'
import {
	createModernMcpClient,
	createTestDatabase,
	startDevServer,
} from '../../../../tools/mcp-test-support.ts'

/**
 * One smoke journey for the stateless 2026-07-28 lane: a real SDK v2 client
 * pinned to the modern revision negotiates over HTTP with OAuth and calls a
 * tool. Everything else about lane behavior is covered by faster node and
 * workers tests beside the implementation (`mcp-auth.workers.test.ts`,
 * `protocol-metrics.node.test.ts`).
 */

test('pinned 2026-07-28 client negotiates the stateless lane and calls search', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using modern = await createModernMcpClient(
		server.origin,
		database.user,
		{ persistDir: database.persistDir },
	)

	const tools = await modern.client.listTools()
	const toolNames = tools.tools.map((tool) => tool.name).sort()
	expect(toolNames).toEqual(['execute', 'search'])
	const searchTool = tools.tools.find((tool) => tool.name === 'search')
	expect(searchTool?.outputSchema).toMatchObject({ type: 'object' })

	const searchResult = await modern.client.callTool({
		name: 'search',
		arguments: { query: 'jobs', limit: 5 },
	})
	expect(searchResult.isError ?? false).toBe(false)
	expect(searchResult.structuredContent).toMatchObject({
		conversationId: expect.any(String),
	})
})
