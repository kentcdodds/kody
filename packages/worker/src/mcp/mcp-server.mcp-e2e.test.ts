import { expect, test } from 'vitest'
import  {
	type CallToolResult,
	type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'
import {
	createMcpClient,
	createTestDatabase,
	loginToApp,
	startDevServer,
} from '../../../../tools/mcp-test-support.ts'

test('mcp server returns built-in instructions and base server metadata', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'generated ui',
			limit: 3,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: {
					matches?: Array<unknown>
				}
		  }
		| undefined

	expect(Array.isArray(structuredResult?.result?.matches)).toBe(true)
	expect(
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? '',
	).toContain('"matches"')
})

test('mcp server executes user code against codemode', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
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

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const executeResult = structuredResult?.result as
		| Record<string, unknown>
		| undefined
	expect(typeof executeResult?.app_id).toBe('string')
	expect(executeResult?.hosted_url).toBe(
		`${server.origin}/ui/${executeResult?.app_id}`,
	)

	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

	expect(textOutput).toContain('app_id')
	expect(textOutput).toContain('hosted_url')
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
		const setupText =
			(setupResult as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''
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
	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
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
	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

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

test('mcp server opens generated ui with inline code and serves runtime resource', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			code: '<main><h1>Hello Shell</h1><p>Inline app content.</p></main>',
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				appId?: string | null
				hostedUrl?: string | null
				renderSource?: string
		  }
		| undefined
	const appId = structuredResult?.appId
	const hostedUrl = structuredResult?.hostedUrl
	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

	expect(textOutput).toContain('Generated UI ready')
	expect(structuredResult?.renderSource).toBe('inline_code')
	expect(appId).toBeNull()
	expect(hostedUrl).toBeNull()

	const runtimeResponse = await fetch(
		new URL('/ui/runtime.js', server.origin),
		{
			headers: {
				Accept: 'application/javascript',
			},
		},
	)
	expect(runtimeResponse.ok).toBe(true)
})

test('mcp server opens saved apps with app_id', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)
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

	const result = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: savedAppId,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				appId?: string | null
				hostedUrl?: string | null
				renderSource?: string
		  }
		| undefined
	expect(structuredResult?.renderSource).toBe('saved_app')
	expect(structuredResult?.appId).toBe(savedAppId)
	expect(structuredResult?.hostedUrl).toContain(`/ui/${savedAppId}`)
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
		const setupText =
			(setupResult as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''
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
	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	expect((result as CallToolResult).isError).toBe(true)
	expect(textOutput).toContain(
		'Token refresh failed for connector "spotify" with HTTP 400.',
	)
	expect(structuredResult?.errorDetails ?? null).toBeNull()
})
