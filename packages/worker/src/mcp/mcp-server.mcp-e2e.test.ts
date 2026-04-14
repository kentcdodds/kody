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

	// The generated UI runtime executes out-of-band HTTP requests with its own app
	// session. Reconnect the MCP client before resuming tool calls so the test
	// exercises a fresh MCP session after that browser-style interaction.
	await using resumedMcpClient = await createMcpClient(
		server.origin,
		database.user,
	)

	const saveResult = await resumedMcpClient.client.callTool({
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

	const savedSearchResult = await resumedMcpClient.client.callTool({
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

	const savedOpenResult = await resumedMcpClient.client.callTool({
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

test('app_server_exec runs snippets in a throwaway worker with app RPC access', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const serverCode =
		'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject { async incrementBy(amount = 1) { const current = Number((await this.ctx.storage.get("count")) ?? 0); const next = current + Number(amount); await this.ctx.storage.put("count", next); return { count: next } } }'

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					title: 'Facet Exec App',
					description: 'Saved app used to verify app_server_exec.',
					clientCode: '<main><h1>Facet Exec App</h1></main>',
					serverCode: ${JSON.stringify(serverCode)},
					hidden: true,
				})
			}`,
		},
	})
	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| { result?: { app_id?: string } }
		| undefined
	const savedAppId = saveStructured?.result?.app_id
	expect(typeof savedAppId).toBe('string')

	await using trivialExecClient = await createMcpClient(
		server.origin,
		database.user,
	)

	const trivialExecResult = await trivialExecClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.app_server_exec({
					app_id: ${JSON.stringify(savedAppId)},
					code: ${JSON.stringify(`return { hello: 'world' }`)},
				})
			}`,
		},
	})
	const trivialExecStructured = (trivialExecResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					ok?: boolean
					app_id?: string
					facet_name?: string
					result?: { hello?: string }
				}
		  }
		| undefined
	expect(trivialExecStructured?.result).toEqual({
		ok: true,
		app_id: savedAppId,
		facet_name: 'main',
		result: { hello: 'world' },
	})

	await using rpcExecClient = await createMcpClient(
		server.origin,
		database.user,
	)

	const rpcExecResult = await rpcExecClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.app_server_exec({
					app_id: ${JSON.stringify(savedAppId)},
					params: { amount: 3 },
					code: ${JSON.stringify(`return await app.call("incrementBy", params.amount ?? 1)`)},
				})
			}`,
		},
	})
	const rpcExecStructured = (rpcExecResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					result?: { count?: number }
				}
		  }
		| undefined
	expect(rpcExecStructured?.result?.result).toEqual({ count: 3 })

	await using exportClient = await createMcpClient(server.origin, database.user)

	const exportResult = await exportClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.app_storage_export({
					app_id: ${JSON.stringify(savedAppId)},
				})
			}`,
		},
	})
	const exportStructured = (exportResult as CallToolResult).structuredContent as
		| {
				result?: {
					export?: {
						entries?: Array<{ key?: string; value?: unknown }>
					}
				}
		  }
		| undefined
	expect(exportStructured?.result?.export?.entries).toEqual([
		{ key: 'count', value: 3 },
	])
})

test('ui_save_app preserves omitted backend code and requires explicit clearing', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const initialServerCode =
		'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject { async readVersion() { return "v1" } }'
	const replacementServerCode =
		'import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject { async readVersion() { return "v2" } }'

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					title: 'Patchable App',
					description: 'Saved app used to verify partial ui_save_app updates.',
					clientCode: '<main><h1>Patchable v1</h1></main>',
					serverCode: ${JSON.stringify(initialServerCode)},
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
	const initialServerCodeId = saveStructured?.result?.server_code_id
	expect(typeof savedAppId).toBe('string')
	expect(typeof initialServerCodeId).toBe('string')
	expect(saveStructured?.result?.has_server_code).toBe(true)

	const clientOnlyUpdateResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					app_id: ${JSON.stringify(savedAppId)},
					clientCode: '<main><h1>Patchable v2</h1></main>',
				})
			}`,
		},
	})
	const clientOnlyUpdateStructured = (clientOnlyUpdateResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					server_code_id?: string
					has_server_code?: boolean
				}
		  }
		| undefined
	expect(clientOnlyUpdateStructured?.result?.server_code_id).toBe(
		initialServerCodeId,
	)
	expect(clientOnlyUpdateStructured?.result?.has_server_code).toBe(true)

	await using preservedSourceClient = await createMcpClient(
		server.origin,
		database.user,
	)

	const preservedSourceResult = await preservedSourceClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_load_app_source({
					app_id: ${JSON.stringify(savedAppId)},
				})
			}`,
		},
	})
	const preservedSourceStructured = (preservedSourceResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					app_id?: string
					title?: string
					description?: string
					client_code?: string
					server_code?: string | null
					server_code_id?: string
					parameters?: null
					hidden?: boolean
				}
		  }
		| undefined
	expect(preservedSourceStructured?.result).toEqual(
		expect.objectContaining({
			app_id: savedAppId,
			title: 'Patchable App',
			description: 'Saved app used to verify partial ui_save_app updates.',
			client_code: '<main><h1>Patchable v2</h1></main>',
			server_code: initialServerCode,
			server_code_id: initialServerCodeId,
			parameters: null,
			hidden: true,
		}),
	)

	const clearServerCodeResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					app_id: ${JSON.stringify(savedAppId)},
					serverCode: null,
				})
			}`,
		},
	})
	const clearServerCodeStructured = (clearServerCodeResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					server_code_id?: string
					has_server_code?: boolean
				}
		  }
		| undefined
	const clearedServerCodeId = clearServerCodeStructured?.result?.server_code_id
	expect(typeof clearedServerCodeId).toBe('string')
	expect(clearedServerCodeId).not.toBe(initialServerCodeId)
	expect(clearServerCodeStructured?.result?.has_server_code).toBe(false)

	await using clearedSourceClient = await createMcpClient(
		server.origin,
		database.user,
	)

	const clearedSourceResult = await clearedSourceClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_load_app_source({
					app_id: ${JSON.stringify(savedAppId)},
				})
			}`,
		},
	})
	const clearedSourceStructured = (clearedSourceResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					app_id?: string
					client_code?: string
					server_code?: string | null
					server_code_id?: string
					hidden?: boolean
				}
		  }
		| undefined
	expect(clearedSourceStructured?.result).toEqual(
		expect.objectContaining({
			app_id: savedAppId,
			client_code: '<main><h1>Patchable v2</h1></main>',
			server_code: null,
			server_code_id: clearedServerCodeId,
			hidden: true,
		}),
	)

	const replaceServerCodeResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					app_id: ${JSON.stringify(savedAppId)},
					serverCode: ${JSON.stringify(replacementServerCode)},
				})
			}`,
		},
	})
	const replaceServerCodeStructured = (
		replaceServerCodeResult as CallToolResult
	).structuredContent as
		| {
				result?: {
					server_code_id?: string
					has_server_code?: boolean
				}
		  }
		| undefined
	const replacementServerCodeId =
		replaceServerCodeStructured?.result?.server_code_id
	expect(typeof replacementServerCodeId).toBe('string')
	expect(replacementServerCodeId).not.toBe(clearedServerCodeId)
	expect(replaceServerCodeStructured?.result?.has_server_code).toBe(true)

	await using replacedSourceClient = await createMcpClient(
		server.origin,
		database.user,
	)

	const replacedSourceResult = await replacedSourceClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_load_app_source({
					app_id: ${JSON.stringify(savedAppId)},
				})
			}`,
		},
	})
	const replacedSourceStructured = (replacedSourceResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					app_id?: string
					client_code?: string
					server_code?: string | null
					server_code_id?: string
					hidden?: boolean
				}
		  }
		| undefined
	expect(replacedSourceStructured?.result).toEqual(
		expect.objectContaining({
			app_id: savedAppId,
			client_code: '<main><h1>Patchable v2</h1></main>',
			server_code: replacementServerCode,
			server_code_id: replacementServerCodeId,
			hidden: true,
		}),
	)
})
