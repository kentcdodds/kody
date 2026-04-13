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
	const authenticateHeader = response.headers.get('WWW-Authenticate') ?? ''
	expect(authenticateHeader).toMatch(/^Bearer\s+/)
	expect(authenticateHeader).toContain(
		`resource_metadata="${server.origin}/.well-known/oauth-protected-resource"`,
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

	const setValueResponse = await fetch(executeEndpoint!, {
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
				return { ok: true }
			}`,
		}),
	})
	expect(setValueResponse.ok).toBe(true)
	const setValuePayload = (await setValueResponse.json()) as {
		ok?: boolean
		result?: { ok?: boolean }
	}
	expect(setValuePayload.ok).toBe(true)
	expect(setValuePayload.result).toEqual({ ok: true })

	const getValueResponse = await fetch(executeEndpoint!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${executeToken}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				const result = await codemode.value_get({
					name: 'example',
					scope: 'session',
				})
				return { result }
			}`,
		}),
	})
	expect(getValueResponse.ok).toBe(true)
	const getValuePayload = (await getValueResponse.json()) as {
		ok?: boolean
		result?: { result?: { name?: string; value?: string } }
	}
	expect(getValuePayload.ok).toBe(true)
	expect(getValuePayload.result?.result).toEqual(
		expect.objectContaining({
			name: 'example',
			value: 'value',
		}),
	)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					title: 'Persistent UI',
					description: 'Saved from test',
					clientCode: '<main><h1>Saved</h1></main>',
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
	expect(savedOpenStructured?.appBackend).toBeNull()
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
	expect(sourceResponse.headers.get('Set-Cookie')).toBeNull()
	const sourcePayload = (await sourceResponse.json()) as {
		app?: { app_backend?: unknown }
	}
	expect(sourcePayload.app?.app_backend).toBeUndefined()
})

test('saved apps with server code expose isolated backend storage', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
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
					server_code_id?: string
					has_server_code?: boolean
				}
		  }
		| undefined
	const savedAppId = saveStructured?.result?.app_id
	expect(typeof savedAppId).toBe('string')
	expect(saveStructured?.result?.has_server_code).toBe(true)
	expect(typeof saveStructured?.result?.server_code_id).toBe('string')

	const openResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: savedAppId,
		},
	})
	const openStructured = (openResult as CallToolResult).structuredContent as
		| {
				appId?: string | null
				appSession?: {
					token?: string
					expiresAt?: string
					endpoints?: { source?: string }
				} | null
				appBackend?: {
					basePath?: string
				} | null
		  }
		| undefined
	expect(openStructured?.appId).toBe(savedAppId)
	expect(openStructured?.appBackend?.basePath).toBe(`/app/${savedAppId}`)
	expect(typeof openStructured?.appSession?.token).toBe('string')

	const sourceResponse = await fetch(
		openStructured!.appSession!.endpoints!.source!,
		{
			headers: {
				Authorization: `Bearer ${openStructured!.appSession!.token}`,
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
			`${openStructured!.appBackend!.basePath}/api/counter`,
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
			`${openStructured!.appBackend!.basePath}/api/counter`,
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
			`${openStructured!.appBackend!.basePath}/api/counter`,
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
