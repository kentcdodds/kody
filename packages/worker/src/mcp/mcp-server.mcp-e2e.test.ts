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
 * real MCP HTTP transport, OAuth flow, and saved-app session wiring all at
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
	expect(authenticateHeader).toContain(
		`resource_metadata="${server.origin}/.well-known/oauth-protected-resource"`,
	)
})

test('authenticated MCP smoke covers core tools, inline UI, and saved app backends', async () => {
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
						source_uris: [
							'https://docs.npmjs.com/cli/v11/commands/npm-install',
							'https://github.com/kentcdodds/kody/blob/main/AGENTS.md',
						],
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

	const memorySearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'npm over pnpm',
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
	expect(memorySearchStructured?.result?.memories?.retrievalQuery).toBe(
		'npm over pnpm',
	)
	expect(memorySearchStructured?.result?.memories?.surfaced).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subject: 'User prefers npm over pnpm',
			}),
		]),
	)

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
	expect(inlineUiStructured?.renderSource).toBe('inline_code')
	expect(typeof inlineUiStructured?.appSession?.token).toBe('string')
	expect(typeof inlineUiStructured?.appSession?.endpoints?.execute).toBe(
		'string',
	)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
					return await codemode.app_save({
						title: 'Facet Counter',
						description: 'Saved app with a backend facet counter',
						clientCode: '<main><h1>Facet Counter</h1></main>',
						serverCode: \`
							import { DurableObject } from 'cloudflare:workers'

							export class App extends DurableObject {
								async fetch(request) {
									const url = new URL(request.url)
									if (url.pathname !== '/api/counter') {
										return new Response('Not found', { status: 404 })
									}
									const current = (await this.ctx.storage.get('count')) ?? 0
									const next = Number(current) + 1
									await this.ctx.storage.put('count', next)
									return Response.json({ count: next })
								}
							}
						\`,
						hidden: true,
					})
				}`,
		},
	})
	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| {
				result?: {
					app_id?: string
					has_server_code?: boolean
					hosted_url?: string
				}
		  }
		| undefined
	const savedAppId = saveStructured?.result?.app_id
	expect(typeof savedAppId).toBe('string')
	expect(saveStructured?.result?.has_server_code).toBe(true)
	expect(saveStructured?.result?.hosted_url).toBe(
		`${server.origin}/ui/${savedAppId}`,
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
				appSession?: {
					token?: string
					endpoints?: { source?: string }
				} | null
				appBackend?: {
					basePath?: string
				} | null
		  }
		| undefined
	expect(savedOpenStructured?.renderSource).toBe('saved_app')
	expect(savedOpenStructured?.appId).toBe(savedAppId)
	expect(savedOpenStructured?.hostedUrl).toBe(
		`${server.origin}/ui/${savedAppId}`,
	)
	expect(savedOpenStructured?.appBackend?.basePath).toBe(`/app/${savedAppId}`)
	expect(typeof savedOpenStructured?.appSession?.token).toBe('string')

	const sourceResponse = await fetch(
		savedOpenStructured!.appSession!.endpoints!.source!,
		{
			headers: {
				Authorization: `Bearer ${savedOpenStructured!.appSession!.token}`,
				Accept: 'application/json',
			},
		},
	)
	expect(sourceResponse.ok).toBe(true)
	const backendCookie = sourceResponse.headers.get('Set-Cookie')
	expect(backendCookie).toContain('kody_generated_ui_app=')
	const scopedCookieHeader = backendCookie?.split(';')[0] ?? ''

	const firstResponse = await fetch(
		new URL(
			`${savedOpenStructured!.appBackend!.basePath}/api/counter`,
			server.origin,
		),
		{
			headers: {
				Accept: 'application/json',
				Cookie: scopedCookieHeader,
			},
		},
	)
	expect(firstResponse.ok).toBe(true)
	expect(await firstResponse.json()).toEqual({ count: 1 })

	const secondResponse = await fetch(
		new URL(
			`${savedOpenStructured!.appBackend!.basePath}/api/counter`,
			server.origin,
		),
		{
			headers: {
				Accept: 'application/json',
				Cookie: scopedCookieHeader,
			},
		},
	)
	expect(secondResponse.ok).toBe(true)
	expect(await secondResponse.json()).toEqual({ count: 2 })

	const unauthenticatedResponse = await fetch(
		new URL(
			`${savedOpenStructured!.appBackend!.basePath}/api/counter`,
			server.origin,
		),
		{
			headers: {
				Accept: 'application/json',
			},
		},
	)
	expect(unauthenticatedResponse.status).toBe(401)
})
