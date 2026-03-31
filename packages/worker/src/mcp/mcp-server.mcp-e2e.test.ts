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

test('mcp server returns built-in instructions and base server metadata', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const tools = await mcpClient.client.listTools()
	const toolDescriptions = new Map(
		tools.tools.map((tool) => [tool.name, tool.inputSchema] as const),
	)
	const conversationIdDescription =
		'Ties related calls together. On the first call, omit this to receive a server-generated ID, or supply your own. Pass the returned `conversationId` on every subsequent call in the same conversation - this enables optimizations like reduced response size.'

	for (const toolName of ['search', 'execute', 'open_generated_ui']) {
		const schema = toolDescriptions.get(toolName) as
			| {
					properties?: {
						conversationId?: {
							description?: string
						}
					}
			  }
			| undefined
		expect(schema?.properties?.conversationId?.description).toContain(
			conversationIdDescription,
		)
	}

	const basicSearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'generated ui',
			limit: 3,
		},
	})

	const basicStructuredResult = (basicSearchResult as CallToolResult)
		.structuredContent as
		| {
				conversationId?: string
				result?: {
					matches?: Array<unknown>
				}
		  }
		| undefined

	const basicConversationId = basicStructuredResult?.conversationId
	const basicContent = (basicSearchResult as CallToolResult).content
	const basicFirstContent = Array.isArray(basicContent) ? basicContent[0] : null

	expect(typeof basicConversationId).toBe('string')
	expect(basicFirstContent).toEqual({
		type: 'text',
		text: `conversationId: ${basicConversationId}`,
	})
	expect(Array.isArray(basicStructuredResult?.result?.matches)).toBe(true)

	const contextualSearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'generated ui',
			conversationId: 'searchctx1234',
			memoryContext: {
				task: 'Find UI-related tools',
				entities: ['generated ui'],
				constraints: ['brief'],
			},
		},
	})

	const contextualStructuredResult = (contextualSearchResult as CallToolResult)
		.structuredContent as
		| {
				conversationId?: string
				result?: {
					matches?: Array<unknown>
				}
		  }
		| undefined

	expect(contextualStructuredResult?.conversationId).toBe('searchctx1234')
	expect(Array.isArray(contextualStructuredResult?.result?.matches)).toBe(true)
})

test('mcp server saves and browses skill collections', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
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

	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| {
				result?: {
					name?: string
					collection?: string | null
					collection_slug?: string | null
				}
		  }
		| undefined
	const savedSkill = saveStructured?.result
	expect(savedSkill?.name).toBe('summarize-agent-prs')
	expect(savedSkill?.collection).toBe('GitHub Workflows')
	expect(savedSkill?.collection_slug).toBe('github-workflows')

	const listResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_list_skill_collections({})
			}`,
		},
	})
	const listStructured = (listResult as CallToolResult).structuredContent as
		| {
				result?: {
					total?: number
					collections?: Array<{
						name?: string
						slug?: string
						skill_count?: number
					}>
				}
		  }
		| undefined
	expect(listStructured?.result?.total).toBe(1)
	expect(listStructured?.result?.collections).toEqual([
		{
			name: 'GitHub Workflows',
			slug: 'github-workflows',
			skill_count: 1,
		},
	])

	const getResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_get_skill({
					name: ${JSON.stringify(savedSkill?.name)},
				})
			}`,
		},
	})
	const getStructured = (getResult as CallToolResult).structuredContent as
		| {
				result?: {
					name?: string
					collection?: string | null
					collection_slug?: string | null
				}
		  }
		| undefined
	expect(getStructured?.result?.name).toBe('summarize-agent-prs')
	expect(getStructured?.result?.collection).toBe('GitHub Workflows')
	expect(getStructured?.result?.collection_slug).toBe('github-workflows')

	const conversationId = 'skills-search-flow'
	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'summarize github pull requests',
			skill_collection: 'github-workflows',
			limit: 25,
			maxResponseSize: 20_000,
			conversationId,
		},
	})
	const searchText = getTextContent((searchResult as CallToolResult).content)
	const searchStructured = (searchResult as CallToolResult).structuredContent as
		| {
				result?: {
					matches?: Array<{
						type?: string
						id?: string
						name?: string
						collection?: string | null
						collectionSlug?: string | null
					}>
				}
		  }
		| undefined
	expect(searchText).toContain('# Search results')
	expect(searchText).toContain('**How to run matches:**')
	expect(searchText).toContain('## Skill — Summarize agent PRs')
	expect(searchText).toContain('(name: `summarize-agent-prs`)')
	expect(
		searchStructured?.result?.matches?.find((match) => match.type === 'skill'),
	).toEqual(
		expect.objectContaining({
			id: savedSkill?.name,
			name: savedSkill?.name,
			collection: 'GitHub Workflows',
			collectionSlug: 'github-workflows',
		}),
	)

	const followupSearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'github pull requests',
			limit: 10,
			conversationId,
		},
	})
	const followupSearchText = getTextContent(
		(followupSearchResult as CallToolResult).content,
	)
	expect(followupSearchText).toContain('# Search results')
	expect(followupSearchText).not.toContain('**How to run matches:**')

	const entityResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			entity: `${savedSkill?.name}:skill`,
		},
	})
	const entityText = getTextContent((entityResult as CallToolResult).content)
	const entityStructured = (entityResult as CallToolResult).structuredContent as
		| {
				result?: {
					kind?: string
					type?: string
					id?: string
					name?: string
					collection?: string | null
				}
		  }
		| undefined
	expect(entityText).toContain('# Skill — Summarize agent PRs')
	expect(entityText).toContain('## Run this skill')
	expect(entityText).toContain('Name: `summarize-agent-prs`')
	expect(entityStructured?.result).toEqual(
		expect.objectContaining({
			kind: 'entity',
			type: 'skill',
			id: savedSkill?.name,
			collection: 'GitHub Workflows',
			collectionSlug: 'github-workflows',
		}),
	)

	const runResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_run_skill({
					name: ${JSON.stringify(savedSkill?.name)},
				})
			}`,
		},
	})
	const runStructured = (runResult as CallToolResult).structuredContent as
		| {
				result?: {
					ok?: boolean
					result?: {
						ok?: boolean
					}
				}
		  }
		| undefined
	expect(runStructured?.result).toEqual(
		expect.objectContaining({
			ok: true,
			result: {
				ok: true,
			},
		}),
	)
})

test('mcp server executes user code against codemode and tracks execute context', async () => {
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

	const saveAppStructuredResult = (saveAppResult as CallToolResult)
		.structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const executeResult = saveAppStructuredResult?.result as
		| Record<string, unknown>
		| undefined
	expect(typeof executeResult?.app_id).toBe('string')
	expect(executeResult?.hosted_url).toBe(
		`${server.origin}/ui/${executeResult?.app_id}`,
	)
	expect(executeResult?.hidden).toBe(true)

	const hiddenSearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'Execute generated app',
		},
	})
	const hiddenSearchText = getTextContent(
		(hiddenSearchResult as CallToolResult).content,
	)
	const hiddenSearchStructured = (hiddenSearchResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					matches?: Array<{
						type?: string
						id?: string
					}>
				}
		  }
		| undefined
	expect(hiddenSearchText).toContain('# Search results')
	expect(
		hiddenSearchStructured?.result?.matches?.some(
			(match) => match.type === 'app' && match.id === executeResult?.app_id,
		),
	).toBe(false)

	const savedAppMetadata = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_get_app({
					app_id: ${JSON.stringify(executeResult?.app_id)},
				})
			}`,
		},
	})
	const savedAppMetadataStructured = (savedAppMetadata as CallToolResult)
		.structuredContent as
		| {
				result?: {
					hidden?: boolean
				}
		  }
		| undefined
	expect(savedAppMetadataStructured?.result?.hidden).toBe(true)

	const searchableUpdateResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.ui_save_app({
					app_id: ${JSON.stringify(executeResult?.app_id)},
					title: 'Execute generated app',
					description: 'Saved through execute.',
					code: '<main><h1>Execute App</h1></main>',
					hidden: false,
				})
			}`,
		},
	})
	const searchableUpdateStructured = (searchableUpdateResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					hidden?: boolean
				}
		  }
		| undefined
	expect(searchableUpdateStructured?.result?.hidden).toBe(false)

	const visibleSearchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'Execute generated app',
			limit: 20,
			maxResponseSize: 20_000,
		},
	})
	const visibleSearchText = getTextContent(
		(visibleSearchResult as CallToolResult).content,
	)
	const visibleSearchStructured = (visibleSearchResult as CallToolResult)
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
	expect(visibleSearchText).toContain('## App — Execute generated app')
	expect(visibleSearchText).toContain(
		`**Hosted URL:** \`${server.origin}/ui/${executeResult?.app_id}\``,
	)
	expect(
		visibleSearchStructured?.result?.matches?.find(
			(match) => match.type === 'app' && match.id === executeResult?.app_id,
		),
	).toEqual(
		expect.objectContaining({
			type: 'app',
			id: executeResult?.app_id,
			hostedUrl: `${server.origin}/ui/${executeResult?.app_id}`,
		}),
	)

	const appEntityResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			entity: `${executeResult?.app_id}:app`,
		},
	})
	const appEntityText = getTextContent(
		(appEntityResult as CallToolResult).content,
	)
	const appEntityStructured = (appEntityResult as CallToolResult)
		.structuredContent as
		| {
				result?: {
					kind?: string
					type?: string
					id?: string
					hostedUrl?: string
				}
		  }
		| undefined
	expect(appEntityText).toContain('# App — Execute generated app')
	expect(appEntityText).toContain('## Open this app')
	expect(appEntityStructured?.result).toEqual(
		expect.objectContaining({
			kind: 'entity',
			type: 'app',
			id: executeResult?.app_id,
			hostedUrl: `${server.origin}/ui/${executeResult?.app_id}`,
		}),
	)

	const contextResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => ({ ok: true })`,
			memoryContext: {
				task: 'Return a small payload',
				constraints: ['no side effects'],
			},
		},
	})

	const contextStructuredResult = (contextResult as CallToolResult)
		.structuredContent as
		| {
				conversationId?: string
				result?: {
					ok?: boolean
				}
		  }
		| undefined

	expect(typeof contextStructuredResult?.conversationId).toBe('string')
	expect(
		(contextStructuredResult?.conversationId ?? '').length,
	).toBeGreaterThan(0)
	expect(contextStructuredResult?.result?.ok).toBe(true)
})

test('mcp server executes directly available codemode helpers', async () => {
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
	const secretSaveRaw = await secretSaveResponse.text()
	expect(secretSaveResponse.ok, secretSaveRaw).toBe(true)

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
		const setupText = getTextContent((setupResult as CallToolResult).content)
		throw new Error(`Helper setup execute failed: ${setupText}`)
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
				error?: unknown
		  }
		| undefined
	const executeResult = structuredResult?.result as
		| Record<string, unknown>
		| undefined
	const textOutput = getTextContent((result as CallToolResult).content)
	if ((result as CallToolResult).isError) {
		expect(textOutput).toContain(
			'Token refresh failed for connector "spotify" with HTTP 400.',
		)
	} else {
		expect(executeResult).toEqual(
			expect.objectContaining({
				status: expect.any(Number),
			}),
		)
	}
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
				error?: unknown
				errorDetails?: Record<string, unknown>
		  }
		| undefined
	const errorDetails = structuredResult?.errorDetails
	const textOutput = getTextContent((result as CallToolResult).content)

	expect((result as CallToolResult).isError).toBe(true)
	expect(textOutput).toContain('Secret "missingToken" was not found.')
	expect(textOutput).toContain(
		'Next step: Open a generated UI so the user can provide and save this secret, then retry the workflow. Do not ask the user to paste the secret into chat.',
	)
	expect(errorDetails).toEqual({
		kind: 'secret_required',
		message: 'Secret "missingToken" was not found.',
		nextStep:
			'Open a generated UI so the user can provide and save this secret, then retry the workflow. Do not ask the user to paste the secret into chat.',
		secretNames: ['missingToken'],
		suggestedAction: {
			type: 'open_generated_ui',
			reason: 'collect_secret',
		},
	})
})

test('mcp server opens generated ui from inline and saved app sources', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const inlineResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			code: '<main><h1>Hello Shell</h1><p>Inline app content.</p></main>',
			conversationId: 'uictx1234567',
			memoryContext: {
				task: 'Render inline UI',
				entities: ['generated ui'],
			},
		},
	})

	const inlineStructuredResult = (inlineResult as CallToolResult)
		.structuredContent as
		| {
				conversationId?: string
				appId?: string | null
				hostedUrl?: string | null
				renderSource?: string
		  }
		| undefined
	expect(inlineStructuredResult?.conversationId).toBe('uictx1234567')
	expect(inlineStructuredResult?.renderSource).toBe('inline_code')
	expect(inlineStructuredResult?.appId).toBeNull()
	expect(inlineStructuredResult?.hostedUrl).toBeNull()

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
		| {
				result?: {
					app_id?: string
				}
		  }
		| undefined
	const savedAppId = savedStructured?.result?.app_id
	expect(typeof savedAppId).toBe('string')

	const savedAppOpenResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: savedAppId,
		},
	})

	const savedAppOpenStructuredResult = (savedAppOpenResult as CallToolResult)
		.structuredContent as
		| {
				appId?: string | null
				hostedUrl?: string | null
				renderSource?: string
		  }
		| undefined
	expect(savedAppOpenStructuredResult?.renderSource).toBe('saved_app')
	expect(savedAppOpenStructuredResult?.appId).toBe(savedAppId)
	expect(savedAppOpenStructuredResult?.hostedUrl).toContain(`/ui/${savedAppId}`)
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

test('mcp server streams token logs from execute', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				console.log('first log')
				await new Promise((resolve) => setTimeout(resolve, 10))
				console.log('second log')
				return { ok: true }
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				logs?: Array<string>
		  }
		| undefined
	const logs = structuredResult?.logs ?? []

	expect(logs.length).toBeGreaterThanOrEqual(2)
	expect(logs[0] ?? '').toContain('first log')
	expect(logs[1] ?? '').toContain('second log')
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
					endpoints?: {
						execute?: string
					}
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
		result?: {
			result?: {
				name?: string
				value?: string
			}
		}
	}
	expect(payload.ok).toBe(true)
	expect(payload.result?.result?.name).toBe('example')
	expect(payload.result?.result?.value).toBe('value')
})

test('mcp server stores connector configs without resolving secret policies', async () => {
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
				name: 'restrictedToken',
				value: 'secret',
				scope: 'user',
				description: 'Restricted',
				allowedHosts: [],
				allowedCapabilities: [],
			}),
		},
	)
	const secretSaveRaw = await secretSaveResponse.text()
	expect(secretSaveResponse.ok, secretSaveRaw).toBe(true)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				await codemode.connector_save({
					name: 'restricted',
					tokenUrl: 'https://example.com',
					apiBaseUrl: 'https://example.com',
					flow: 'pkce',
					clientIdValueName: 'client-id',
					accessTokenSecretName: 'restrictedToken',
					refreshTokenSecretName: 'restrictedToken',
					clientSecretSecretName: null,
					requiredHosts: [],
				})
				return { ok: true }
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: {
					ok?: boolean
				}
		  }
		| undefined
	expect((result as CallToolResult).isError).toBe(false)
	expect(structuredResult?.result?.ok).toBe(true)
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
	const secretSaveRaw = await secretSaveResponse.text()
	expect(secretSaveResponse.ok, secretSaveRaw).toBe(true)

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
		| {
				errorDetails?: Record<string, unknown>
		  }
		| undefined
	const errorDetails = structuredResult?.errorDetails
	expect((result as CallToolResult).isError).toBe(true)
	expect(errorDetails?.kind).toBe('host_approval_required_batch')
})

test('mcp server supports multi-step execute workflows', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				const first = await codemode.ui_save_app({
					title: 'Workflow',
					description: 'First',
					code: '<main>first</main>',
				})
				const second = await codemode.ui_save_app({
					title: 'Workflow',
					description: 'Second',
					code: '<main>second</main>',
				})
				return { first, second }
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: { first?: { app_id?: string }; second?: { app_id?: string } }
		  }
		| undefined
	const resultBody = structuredResult?.result

	expect(typeof resultBody?.first?.app_id).toBe('string')
	expect(typeof resultBody?.second?.app_id).toBe('string')
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
	const secretSaveRaw = await secretSaveResponse.text()
	expect(secretSaveResponse.ok, secretSaveRaw).toBe(true)

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
		const setupText = getTextContent((setupResult as CallToolResult).content)
		throw new Error(`Helper setup execute failed: ${setupText}`)
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
		| {
				errorDetails?: Record<string, unknown>
		  }
		| undefined
	const textOutput = getTextContent((result as CallToolResult).content)
	expect((result as CallToolResult).isError).toBe(true)
	expect(textOutput).toContain('Secrets require host approval:')
	expect(textOutput).toContain('restrictedRefreshToken')
	expect(textOutput).toContain('accounts.spotify.com')
	expect(structuredResult?.errorDetails?.kind).toBe(
		'host_approval_required_batch',
	)
})

test('mcp server persists user MCP server instructions overlay', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const setResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_set_mcp_server_instructions({
					instructions: 'Prefer short answers.',
				})
			}`,
		},
	})
	const setStructured = (setResult as CallToolResult).structuredContent as
		| {
				result?: {
					ok?: boolean
					max_length?: number
					instructions?: string | null
				}
		  }
		| undefined
	expect(setStructured?.result?.ok).toBe(true)
	expect(setStructured?.result?.instructions).toBe('Prefer short answers.')
	expect(setStructured?.result?.max_length).toBe(4_000)

	const getResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_get_mcp_server_instructions({})
			}`,
		},
	})
	const getStructured = (getResult as CallToolResult).structuredContent as
		| {
				result?: {
					instructions?: string | null
					max_length?: number
				}
		  }
		| undefined
	expect(getStructured?.result?.instructions).toBe('Prefer short answers.')
	expect(getStructured?.result?.max_length).toBe(4_000)

	const clearResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				return await codemode.meta_set_mcp_server_instructions({
					instructions: '',
				})
			}`,
		},
	})
	const clearStructured = (clearResult as CallToolResult).structuredContent as
		| {
				result?: {
					instructions?: string | null
				}
		  }
		| undefined
	expect(clearStructured?.result?.instructions).toBeNull()
})
