import { setTimeout as delay } from 'node:timers/promises'
import { expect, test } from 'vitest'
import type {
	CallToolResult,
	ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'
import {
	createMcpClient,
	createTestDatabase,
	fetchJson,
	loginToApp,
	startDevServer,
} from '#mcp/mcp-test-support.ts'
import type { Env } from '#worker/env.ts'

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
				results?: Array<unknown>
		  }
		| undefined

	expect(structuredResult?.results?.length ?? 0).toBeGreaterThan(0)
	expect(
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? '',
	).toContain('generated ui')
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
	expect(textOutput).toContain('meta_save_skill')
})

test('mcp server executes imported @kody/codemode-utils helpers', async () => {
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
				const { createCodemodeUtils } = await import('@kody/codemode-utils')
				const { createAuthenticatedFetch } = createCodemodeUtils(codemode)
				const spotifyFetch = await createAuthenticatedFetch('spotify')
				const response = await spotifyFetch('/me/player')
				return {
					status: response.status,
					body: await response.json(),
				}
			}`,
		},
	})

	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

	expect((result as CallToolResult).isError).toBe(true)
	expect(textOutput).toContain(
		'Token refresh failed for connector "spotify" with HTTP 400.',
	)
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
				app_id?: string
				hosted_url?: string
		  }
		| undefined
	const appId = structuredResult?.app_id
	const hostedUrl = structuredResult?.hosted_url
	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

	expect(textOutput).toContain('hosted_url')
	expect(typeof appId).toBe('string')
	expect(typeof hostedUrl).toBe('string')
	expect(hostedUrl).toContain(`/ui/${appId}`)

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
	const appCookieHeader = await loginToApp(server.origin, database.user)

	const saved = await fetchJson(server.origin, '/ui/apps.json', {
		method: 'POST',
		headers: {
			Cookie: appCookieHeader,
		},
		body: JSON.stringify({
			title: 'Persistent UI',
			description: 'Saved from test',
			code: '<main><h1>Saved</h1></main>',
			archived: false,
		}),
	})

	const result = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: saved.app_id,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				app_id?: string
				hosted_url?: string
		  }
		| undefined
	expect(structuredResult?.app_id).toBe(saved.app_id)
	expect(structuredResult?.hosted_url).toContain(`/ui/${saved.app_id}`)
})

test('mcp server blocks execute when caller context lacks a user', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				await codemode.value_set({
					name: 'example',
					value: 'example',
					scope: 'user',
				})
				return { ok: true }
			}`,
		},
		headers: {
			Authorization: 'Bearer test-token-without-user',
		},
	})

	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	expect((result as CallToolResult).isError).toBe(true)
	expect(textOutput).toContain('Must be signed in to use this capability.')
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
				await delay(10)
				console.log('second log')
				return { ok: true }
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				logs?: Array<{ level?: string; message?: string }>
		  }
		| undefined
	const logs = structuredResult?.logs ?? []

	expect(logs.length).toBeGreaterThanOrEqual(2)
	expect(logs[0]?.message ?? '').toContain('first log')
	expect(logs[1]?.message ?? '').toContain('second log')
})

test('mcp server supports custom storage context for execute', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const storageContext = {
		sessionId: 'session-1',
		appId: 'app-1',
	}

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
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
		},
		headers: {
			'X-Kody-Storage-Context': JSON.stringify(storageContext),
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const executeResult = structuredResult?.result as
		| { result?: { name?: string; value?: string } }
		| undefined

	expect(executeResult?.result?.name).toBe('example')
	expect(executeResult?.result?.value).toBe('value')
})

test('mcp server resolves capability access errors into structured guidance', async () => {
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
				errorDetails?: Record<string, unknown>
		  }
		| undefined
	const errorDetails = structuredResult?.errorDetails
	expect((result as CallToolResult).isError).toBe(true)
	expect(errorDetails?.kind).toBe('secret_capability_access_required')
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
	expect(errorDetails?.kind).toBe('host_approval_required')
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

test('mcp server resolves capability access errors in execute-time helpers', async () => {
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
				const { createCodemodeUtils } = await import('@kody/codemode-utils')
				const { refreshAccessToken } = createCodemodeUtils(codemode)
				return await refreshAccessToken('spotify')
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
	expect(errorDetails?.kind).toBe('secret_capability_access_required')
})
