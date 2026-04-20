import { expect, test } from 'vitest'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createMcpClient,
	createTestDatabase,
	loginToApp,
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
	expect(authenticateHeader).toContain(
		`resource_metadata="${server.origin}/.well-known/oauth-protected-resource"`,
	)
})

test('authenticated MCP smoke covers core tools, inline UI, and hosted package apps', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)
	const appCookie = await loginToApp(server.origin, database.user)

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
			code: `import { codemode } from 'kody:runtime'

				export default async function upsertMemory() {
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
			code: `import { codemode } from 'kody:runtime'

export default async function savePackage() {
	return await codemode.package_save({
		files: [
			{
				path: 'package.json',
				content: ${JSON.stringify(
					JSON.stringify(
						{
							name: '@kody/facet-counter',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'facet-counter',
								description: 'Hosted package app with a backend counter',
								app: {
									entry: './src/app.ts',
								},
							},
						},
						null,
						2,
					),
				)},
			},
			{
				path: 'src/index.ts',
				content: ${JSON.stringify(
					'export default async function noop() { return null }\n',
				)},
			},
			{
				path: 'src/app.ts',
				content: ${JSON.stringify(`import { DurableObject } from 'cloudflare:workers'

export class Counter extends DurableObject {
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

export default {
  async fetch(request, env) {
    const id = env.COUNTER.idFromName('main')
    const stub = env.COUNTER.get(id)
    return await stub.fetch(request)
  },
}
`)},
			},
		],
	})
}`,
		},
	})
	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| {
				result?: {
					package_id?: string
					kody_id?: string
					has_app?: boolean
				}
		  }
		| undefined
	const savedPackageId = saveStructured?.result?.package_id
	expect(typeof savedPackageId).toBe('string')
	expect(saveStructured?.result?.has_app).toBe(true)
	expect(saveStructured?.result?.kody_id).toBe('facet-counter')

	const savedOpenResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			package_id: savedPackageId,
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
	expect(savedOpenStructured?.renderSource).toBe('saved_package')
	expect(savedOpenStructured?.appId).toBe(savedPackageId)
	expect(savedOpenStructured?.hostedUrl).toBe(
		`${server.origin}/packages/facet-counter`,
	)

	const firstResponse = await fetch(
		new URL('/packages/facet-counter/api/counter', server.origin),
		{
			headers: {
				Accept: 'application/json',
				Cookie: appCookie,
			},
		},
	)
	expect(firstResponse.ok).toBe(true)
	expect(await firstResponse.json()).toEqual({ count: 1 })

	const secondResponse = await fetch(
		new URL('/packages/facet-counter/api/counter', server.origin),
		{
			headers: {
				Accept: 'application/json',
				Cookie: appCookie,
			},
		},
	)
	expect(secondResponse.ok).toBe(true)
	expect(await secondResponse.json()).toEqual({ count: 2 })

	const unauthenticatedResponse = await fetch(
		new URL('/packages/facet-counter/api/counter', server.origin),
		{
			headers: { Accept: 'application/json' },
			redirect: 'manual',
		},
	)
	expect(unauthenticatedResponse.status).toBeGreaterThanOrEqual(300)
	expect(unauthenticatedResponse.status).toBeLessThan(400)
	expect(unauthenticatedResponse.headers.get('Location')).toBeTruthy()
})
