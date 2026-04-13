import { expect, test } from 'vitest'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createMcpClient,
	createTestDatabase,
	startDevServer,
} from '../../../../tools/mcp-test-support.ts'

test('mcp endpoint requires OAuth bearer auth', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)

	const response = await fetch(new URL('/mcp', server.origin), {
		headers: {
			Accept: 'application/json, text/event-stream',
		},
	})

	expect(response.status).toBe(401)
	expect(response.headers.get('WWW-Authenticate') ?? '').toContain(
		'resource_metadata=',
	)
})

test('authenticated mcp client can list tools, execute codemode, and search memories', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const tools = await mcpClient.client.listTools()
	expect(tools.tools.map((tool) => tool.name)).toEqual(
		expect.arrayContaining(['execute', 'open_generated_ui', 'search']),
	)

	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'generated ui',
			limit: 3,
		},
	})
	const searchStructured = (searchResult as CallToolResult).structuredContent as
		| {
				conversationId?: string
				result?: { matches?: Array<unknown> }
		  }
		| undefined
	expect(typeof searchStructured?.conversationId).toBe('string')
	expect(Array.isArray(searchStructured?.result?.matches)).toBe(true)

	const upsertResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_memory_upsert({
					subject: 'User prefers npm over pnpm',
					summary: 'Always use npm commands in this repository.',
					category: 'preference',
					tags: ['package-manager', 'repo-workflow'],
					verified_by_agent: true,
					verification_reference: 'verify-search-fallback-1',
				})
			}`,
		},
	})
	const upsertStructured = (upsertResult as CallToolResult).structuredContent as
		| { result?: { memory?: { id?: string } } }
		| undefined
	expect(typeof upsertStructured?.result?.memory?.id).toBe('string')

	const query = 'npm over pnpm'
	const memorySearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query,
		},
	})
	const memorySearchStructured = (memorySearchResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					memories?: {
						retrievalQuery?: string
						surfaced?: Array<{ subject?: string }>
					}
				}
		  }
		| undefined

	expect(memorySearchStructured?.result?.memories?.retrievalQuery).toBe(query)
	expect(memorySearchStructured?.result?.memories?.surfaced).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subject: 'User prefers npm over pnpm',
			}),
		]),
	)
})

test('authenticated mcp client can open generated ui and reopen a saved app', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const inlineResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			code: '<main><h1>Storage Context</h1></main>',
		},
	})
	const inlineStructured = (inlineResult as CallToolResult).structuredContent as
		| {
				renderSource?: string
				appSession?: {
					token?: string
					endpoints?: { execute?: string }
				} | null
		  }
		| undefined
	const executeEndpoint = inlineStructured?.appSession?.endpoints?.execute
	const executeToken = inlineStructured?.appSession?.token
	expect(inlineStructured?.renderSource).toBe('inline_code')
	expect(typeof executeEndpoint).toBe('string')
	expect(typeof executeToken).toBe('string')

	const executeResponse = await fetch(executeEndpoint!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${executeToken}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				await codemode.value_set({
					name: 'example',
					value: 'value',
					scope: 'session',
				})
				const result = await codemode.value_get({
					name: 'example',
					scope: 'session',
				})
				return { result }
			}`,
		}),
	})
	expect(executeResponse.ok).toBe(true)
	const executePayload = (await executeResponse.json()) as {
		ok?: boolean
		result?: { result?: { name?: string; value?: string } }
	}
	expect(executePayload.ok).toBe(true)
	expect(executePayload.result?.result).toEqual({
		name: 'example',
		value: 'value',
	})

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					title: 'Persistent UI',
					description: 'Saved from test',
					code: '<main><h1>Saved</h1></main>',
					hidden: false,
				})
			}`,
		},
	})
	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| { result?: { app_id?: string } }
		| undefined
	const savedAppId = saveStructured?.result?.app_id
	expect(typeof savedAppId).toBe('string')

	const savedSearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'Persistent UI',
			limit: 10,
			maxResponseSize: 20_000,
		},
	})
	const savedSearchStructured = (savedSearchResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					matches?: Array<{
						type?: string
						id?: string
						hostedUrl?: string
					}>
				}
		  }
		| undefined
	expect(
		savedSearchStructured?.result?.matches?.find(
			(match) => match.type === 'app' && match.id === savedAppId,
		),
	).toEqual(
		expect.objectContaining({
			type: 'app',
			id: savedAppId,
			hostedUrl: `${server.origin}/ui/${savedAppId}`,
		}),
	)

	const savedOpenResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: savedAppId,
		},
	})
	const savedOpenStructured = (savedOpenResult as CallToolResult)
		.structuredContent as
		| {
				renderSource?: string
				appId?: string | null
				hostedUrl?: string | null
		  }
		| undefined
	expect(savedOpenStructured?.renderSource).toBe('saved_app')
	expect(savedOpenStructured?.appId).toBe(savedAppId)
	expect(savedOpenStructured?.hostedUrl).toBe(
		`${server.origin}/ui/${savedAppId}`,
	)
})
