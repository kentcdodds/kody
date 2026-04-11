import { expect, test } from 'vitest'
import {
	type CallToolResult,
	type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'
import {
	createMcpClient,
	createTestDatabase,
	loginToApp,
	startDevServer,
} from '../../../../tools/mcp-test-support.ts'

function getTextContent(content: CallToolResult['content']) {
	if (!Array.isArray(content)) return ''
	const textBlocks = content.filter(
		(item): item is Extract<ContentBlock, { type: 'text' }> =>
			item.type === 'text' && typeof item.text === 'string',
	)
	const nonMetadata = textBlocks.find(
		(item) => !item.text.startsWith('conversationId: '),
	)
	return nonMetadata?.text ?? textBlocks[0]?.text ?? ''
}

test('mcp server lists tools and search returns matches', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const tools = await mcpClient.client.listTools()
	expect(tools.tools.some((t) => t.name === 'search')).toBe(true)

	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'generated ui',
			limit: 3,
		},
	})
	const structured = (searchResult as CallToolResult).structuredContent as
		| {
				conversationId?: string
				result?: { matches?: Array<unknown> }
		  }
		| undefined
	expect(typeof structured?.conversationId).toBe('string')
	expect(Array.isArray(structured?.result?.matches)).toBe(true)
})

test('mcp search uses the query as memory context fallback', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	await mcpClient.client.callTool({
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

	const query = 'npm over pnpm'
	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query,
		},
	})
	const structured = (searchResult as CallToolResult).structuredContent as
		| {
				result?: {
					memories?: {
						retrievalQuery?: string
						surfaced?: Array<{ subject?: string }>
					}
				}
		  }
		| undefined

	expect(structured?.result?.memories?.retrievalQuery).toBe(query)
	expect(structured?.result?.memories?.surfaced).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subject: 'User prefers npm over pnpm',
			}),
		]),
	)
})

test('mcp server saves skills and run_skill works', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_save_skill({
					name: 'summarize-agent-prs',
					title: 'Summarize agent PRs',
					description: 'Summarize open pull requests for agents.',
					collection: 'GitHub Workflows',
					keywords: ['github', 'pull requests'],
					code: 'async () => ({ ok: true })',
					search_text: 'summarize github pull requests',
					read_only: true,
					idempotent: true,
					destructive: false,
				})
			}`,
		},
	})

	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'summarize github pull requests',
			skill_collection: 'github-workflows',
			limit: 25,
			maxResponseSize: 20_000,
		},
	})
	const searchStructured = (searchResult as CallToolResult).structuredContent as
		| {
				result?: {
					matches?: Array<{ type?: string; id?: string }>
				}
		  }
		| undefined
	expect(
		searchStructured?.result?.matches?.some(
			(m) => m.type === 'skill' && m.id === 'summarize-agent-prs',
		),
	).toBe(true)

	const runResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_run_skill({ name: 'summarize-agent-prs' })
			}`,
		},
	})
	const runStructured = (runResult as CallToolResult).structuredContent as
		| {
				result?: { ok?: boolean; result?: { ok?: boolean } }
		  }
		| undefined
	expect(runStructured?.result?.ok).toBe(true)
	expect(runStructured?.result?.result).toEqual({ ok: true })
})

test('mcp server ui_save_app hidden flag and search listing', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveAppResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Execute generated app',
						description: 'Saved through execute.',
						code: '<main><h1>Execute App</h1></main>',
					})`,
		},
	})
	const saveStructured = (saveAppResult as CallToolResult).structuredContent as
		| { result?: Record<string, unknown> }
		| undefined
	const appId = saveStructured?.result?.app_id
	expect(typeof appId).toBe('string')
	expect(saveStructured?.result?.hidden).toBe(true)

	const hiddenSearch = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'Execute generated app',
		},
	})
	const hiddenStructured = (hiddenSearch as CallToolResult).structuredContent as
		| {
				result?: { matches?: Array<{ type?: string; id?: string }> }
		  }
		| undefined
	expect(
		hiddenStructured?.result?.matches?.some(
			(m) => m.type === 'app' && m.id === appId,
		),
	).toBe(false)

	await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					app_id: ${JSON.stringify(appId)},
					title: 'Execute generated app',
					description: 'Saved through execute.',
					code: '<main><h1>Execute App</h1></main>',
					hidden: false,
				})
			}`,
		},
	})

	const visibleSearch = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'Execute generated app',
			limit: 20,
			maxResponseSize: 20_000,
		},
	})
	const visibleStructured = (visibleSearch as CallToolResult)
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
		visibleStructured?.result?.matches?.find(
			(m) => m.type === 'app' && m.id === appId,
		),
	).toEqual(
		expect.objectContaining({
			type: 'app',
			id: appId,
			hostedUrl: `${server.origin}/ui/${appId}`,
		}),
	)
})

test('mcp memory verify upsert and delete', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const verifyResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_memory_verify({
					subject: 'User prefers npm over pnpm',
					summary: 'Always use npm commands in this repository.',
					category: 'preference',
					tags: ['package-manager', 'repo-workflow'],
				})
			}`,
		},
	})
	const verifyStructured = (verifyResult as CallToolResult).structuredContent as
		| { result?: { related_memories?: Array<unknown> } }
		| undefined
	expect(verifyStructured?.result?.related_memories).toEqual([])

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
					verification_reference: 'verify-1',
				})
			}`,
		},
	})
	const upsertStructured = (upsertResult as CallToolResult).structuredContent as
		| { result?: { memory?: { id?: string } } }
		| undefined
	const memoryId = upsertStructured?.result?.memory?.id
	expect(typeof memoryId).toBe('string')

	const softDeleteResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_memory_delete({
					memory_id: ${JSON.stringify(memoryId)},
					verified_by_agent: true,
					verification_reference: 'verify-delete-1',
				})
			}`,
		},
	})
	const softDeleteStructured = (softDeleteResult as CallToolResult)
		.structuredContent as
		| { result?: { memory?: { status?: string } | null } }
		| undefined
	expect(softDeleteStructured?.result?.memory?.status).toBe('deleted')

	const getDeletedResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_memory_get({
					memory_id: ${JSON.stringify(memoryId)},
				})
			}`,
		},
	})
	const getDeletedStructured = (getDeletedResult as CallToolResult)
		.structuredContent as { result?: { status?: string } | null } | undefined
	expect(getDeletedStructured?.result?.status).toBe('deleted')
})

test('mcp server executes codemode helpers with connector', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)
	const appCookieHeader = await loginToApp(server.origin, database.user)

	const secretSaveResponse = await fetch(
		new URL('/account/secrets.json', server.origin),
		{
			method: 'POST',
			headers: {
				Cookie: appCookieHeader,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				action: 'save',
				name: 'spotifyRefreshToken',
				value: 'spotify-refresh-token',
				scope: 'user',
				description: 'Spotify OAuth refresh token',
				allowedHosts: ['accounts.spotify.com', 'api.spotify.com'],
				allowedCapabilities: [],
			}),
		},
	)
	expect(secretSaveResponse.ok, await secretSaveResponse.text()).toBe(true)

	const setupResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				await codemode.value_set({
					name: 'spotify-client-id',
					value: 'spotify-client-id-value',
					scope: 'user',
					description: 'Spotify OAuth client id',
				})
				await codemode.connector_save({
					name: 'spotify',
					tokenUrl: 'https://accounts.spotify.com/api/token',
					apiBaseUrl: 'https://api.spotify.com/v1',
					flow: 'pkce',
					clientIdValueName: 'spotify-client-id',
					clientSecretSecretName: null,
					accessTokenSecretName: 'spotifyAccessToken',
					refreshTokenSecretName: 'spotifyRefreshToken',
					requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
				})
				return { ok: true }
			}`,
		},
	})
	if ((setupResult as CallToolResult).isError) {
		throw new Error(
			`Helper setup execute failed: ${getTextContent((setupResult as CallToolResult).content)}`,
		)
	}

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				const spotifyFetch = await createAuthenticatedFetch('spotify')
				const response = await spotifyFetch('/me/player')
				return {
					status: response.status,
					body: await response.json(),
				}
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const executeResult = structuredResult?.result as
		| Record<string, unknown>
		| undefined
	expect(
		(result as CallToolResult).isError ||
			typeof executeResult?.status === 'number',
	).toBe(true)
})

test('mcp server returns structured guidance for missing secret errors in execute', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				await fetch('https://example.com/private', {
					headers: {
						Authorization: 'Bearer {{secret:missingToken|scope=user}}',
					},
				})
				return { ok: true }
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				errorDetails?: Record<string, unknown>
		  }
		| undefined
	expect((result as CallToolResult).isError).toBe(true)
	expect(structuredResult?.errorDetails).toEqual(
		expect.objectContaining({
			kind: 'secret_required',
			secretNames: ['missingToken'],
			suggestedAction: {
				type: 'open_generated_ui',
				reason: 'collect_secret',
			},
		}),
	)
})

test('mcp server opens generated ui from inline and saved app sources', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const inlineResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			code: '<main><h1>Hello Shell</h1><p>Inline app content.</p></main>',
		},
	})
	const inlineStructured = (inlineResult as CallToolResult).structuredContent as
		| {
				renderSource?: string
				appId?: string | null
				hostedUrl?: string | null
		  }
		| undefined
	expect(inlineStructured?.renderSource).toBe('inline_code')
	expect(inlineStructured?.appId).toBeNull()
	expect(inlineStructured?.hostedUrl).toBeNull()

	const runtimeResponse = await fetch(
		new URL('/ui/runtime.js', server.origin),
		{
			headers: {
				Accept: 'application/javascript',
			},
		},
	)
	expect(runtimeResponse.ok).toBe(true)

	const savedResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					title: 'Persistent UI',
					description: 'Saved from test',
					code: '<main><h1>Saved</h1></main>',
				})
			}`,
		},
	})
	const savedStructured = (savedResult as CallToolResult).structuredContent as
		| { result?: { app_id?: string } }
		| undefined
	const savedAppId = savedStructured?.result?.app_id
	expect(typeof savedAppId).toBe('string')

	const savedAppOpenResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: savedAppId,
		},
	})
	const savedOpenStructured = (savedAppOpenResult as CallToolResult)
		.structuredContent as
		| {
				appId?: string | null
				hostedUrl?: string | null
				renderSource?: string
		  }
		| undefined
	expect(savedOpenStructured?.renderSource).toBe('saved_app')
	expect(savedOpenStructured?.appId).toBe(savedAppId)
	expect(savedOpenStructured?.hostedUrl).toContain(`/ui/${savedAppId}`)
})

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

test('generated UI execute supports session storage context', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const openResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			code: '<main><h1>Storage Context</h1></main>',
		},
	})
	const openStructured = (openResult as CallToolResult).structuredContent as
		| {
				appSession?: {
					token?: string
					endpoints?: { execute?: string }
				} | null
		  }
		| undefined
	const executeEndpoint = openStructured?.appSession?.endpoints?.execute
	const executeToken = openStructured?.appSession?.token
	expect(typeof executeEndpoint).toBe('string')
	expect(typeof executeToken).toBe('string')

	const response = await fetch(executeEndpoint!, {
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
	expect(response.ok).toBe(true)
	const payload = (await response.json()) as {
		ok?: boolean
		result?: { result?: { name?: string; value?: string } }
	}
	expect(payload.ok).toBe(true)
	expect(payload.result?.result?.name).toBe('example')
	expect(payload.result?.result?.value).toBe('value')
})

test('mcp server resolves host approval errors into structured guidance', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)
	const appCookieHeader = await loginToApp(server.origin, database.user)

	const secretSaveResponse = await fetch(
		new URL('/account/secrets.json', server.origin),
		{
			method: 'POST',
			headers: {
				Cookie: appCookieHeader,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				action: 'save',
				name: 'hostApprovalToken',
				value: 'secret',
				scope: 'user',
				description: 'Host approval',
				allowedHosts: [],
				allowedCapabilities: ['fetch'],
			}),
		},
	)
	expect(secretSaveResponse.ok, await secretSaveResponse.text()).toBe(true)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				await fetch('https://example.com', {
					headers: {
						Authorization: 'Bearer {{secret:hostApprovalToken|scope=user}}',
					},
				})
				return { ok: true }
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| { errorDetails?: Record<string, unknown> }
		| undefined
	expect((result as CallToolResult).isError).toBe(true)
	expect(structuredResult?.errorDetails?.kind).toBe(
		'host_approval_required_batch',
	)
})

test('mcp server exposes direct refreshAccessToken helper', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)
	const appCookieHeader = await loginToApp(server.origin, database.user)

	const secretSaveResponse = await fetch(
		new URL('/account/secrets.json', server.origin),
		{
			method: 'POST',
			headers: {
				Cookie: appCookieHeader,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				action: 'save',
				name: 'restrictedRefreshToken',
				value: 'secret',
				scope: 'user',
				description: 'Restricted for helper',
				allowedHosts: [],
				allowedCapabilities: [],
			}),
		},
	)
	expect(secretSaveResponse.ok, await secretSaveResponse.text()).toBe(true)

	const setupResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				await codemode.value_set({
					name: 'spotify-client-id',
					value: 'spotify-client-id-value',
					scope: 'user',
					description: 'Spotify OAuth client id',
				})
				await codemode.connector_save({
					name: 'spotify',
					tokenUrl: 'https://accounts.spotify.com/api/token',
					apiBaseUrl: 'https://api.spotify.com/v1',
					flow: 'pkce',
					clientIdValueName: 'spotify-client-id',
					clientSecretSecretName: null,
					accessTokenSecretName: 'spotifyAccessToken',
					refreshTokenSecretName: 'restrictedRefreshToken',
					requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
				})
				return { ok: true }
			}`,
		},
	})
	if ((setupResult as CallToolResult).isError) {
		throw new Error(
			`Helper setup execute failed: ${getTextContent((setupResult as CallToolResult).content)}`,
		)
	}

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await refreshAccessToken('spotify')
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| { errorDetails?: Record<string, unknown> }
		| undefined
	expect((result as CallToolResult).isError).toBe(true)
	expect(structuredResult?.errorDetails?.kind).toBe(
		'host_approval_required_batch',
	)
})
