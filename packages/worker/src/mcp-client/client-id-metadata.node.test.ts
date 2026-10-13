import { expect, test } from 'vitest'
import {
	buildMcpClientIdMetadataDocument,
	createMcpClientOAuthProvider,
	handleMcpClientIdMetadataRequest,
	mcpClientIdMetadataPath,
	mcpClientName,
	resolveMcpClientMetadataUrl,
	resolveMcpOAuthClientMode,
} from './client-id-metadata.ts'
import {
	buildMcpOAuthAttemptIdentity,
	markMcpOAuthAttemptVerified,
	mcpOAuthAttemptStorageKey,
	mcpOAuthAttemptVerifiedStorageKey,
	McpOAuthAttemptIdentityError,
	writeMcpOAuthAttemptIdentity,
} from './oauth-attempt.ts'
import {
	McpOAuthFailedError,
	mcpOAuthFailedCode,
} from './oauth-issuer-endpoints.ts'
import { mcpOAuthRefreshTokenStorageKey } from './oauth-token-recovery.ts'

const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
const tokenKey = '/Kody/server-home/client-1/token'
const refreshKey = mcpOAuthRefreshTokenStorageKey('server-home')

test('CIMD resolves only for HTTPS, serves the origin-bound document, and wires the OAuth provider', async () => {
	const origin = 'https://kody.codes'
	const documentUrl = `${origin}${mcpClientIdMetadataPath}`
	expect(resolveMcpClientMetadataUrl(callbackUrl)).toBe(documentUrl)
	expect(
		resolveMcpClientMetadataUrl(
			'http://localhost:8787/account/mcp-servers/oauth/callback',
		),
	).toBeUndefined()
	expect(resolveMcpClientMetadataUrl('not-a-url')).toBeUndefined()

	const document = buildMcpClientIdMetadataDocument(`${origin}/ignored`)
	expect(document.client_id).toBe(documentUrl)
	expect(document.client_uri).toBe(origin)
	expect(document.client_name).toBe(mcpClientName)
	expect(document.redirect_uris).toEqual([callbackUrl])
	expect(document.token_endpoint_auth_method).toBe('none')

	const handle = (method: string, url = documentUrl) =>
		handleMcpClientIdMetadataRequest(new Request(url, { method }))
	const getResponse = handle('GET')
	expect(getResponse?.status).toBe(200)
	expect(getResponse?.headers.get('Content-Type')).toBe('application/json')
	expect(await getResponse?.json()).toMatchObject({
		client_id: documentUrl,
		redirect_uris: [callbackUrl],
	})
	const headResponse = handle('HEAD')
	expect(headResponse?.status).toBe(200)
	expect(await headResponse?.text()).toBe('')
	expect(handle('OPTIONS')?.status).toBe(204)
	expect(handle('GET', `${origin}/oauth/authorize`)).toBeNull()
	expect(handle('POST')).toBeNull()

	const storage = {} as DurableObjectStorage
	const httpsProvider = createMcpClientOAuthProvider(storage, callbackUrl)
	expect(httpsProvider.clientMetadataUrl).toBe(documentUrl)
	expect(httpsProvider.clientMetadata.redirect_uris).toEqual([callbackUrl])
	expect(
		createMcpClientOAuthProvider(
			storage,
			'http://127.0.0.1:8787/account/mcp-servers/oauth/callback',
		).clientMetadataUrl,
	).toBeUndefined()
})

function createMemoryStorage() {
	const values = new Map<string, unknown>()
	const hooks: {
		afterPut?: (key: string, value: unknown) => Promise<void>
	} = {}
	const storage = {
		put: async (key: string, value: unknown) => {
			values.set(key, value)
			await hooks.afterPut?.(key, value)
		},
		get: async (key: string) => values.get(key),
		delete: async (key: string | Array<string>) => {
			for (const item of Array.isArray(key) ? key : [key]) {
				values.delete(item)
			}
		},
		list: async ({ prefix }: { prefix?: string } = {}) =>
			new Map(
				[...values.entries()].filter(([key]) =>
					prefix ? key.startsWith(prefix) : true,
				),
			),
	} as unknown as DurableObjectStorage
	return { storage, values, hooks }
}

function makeProvider(storage: DurableObjectStorage, clientId?: string) {
	const provider = createMcpClientOAuthProvider(storage, callbackUrl)
	provider.serverId = 'server-home'
	if (clientId) provider.clientId = clientId
	return provider
}

function bearer(access_token: string, refresh_token?: string) {
	return {
		access_token,
		...(refresh_token ? { refresh_token } : {}),
		token_type: 'Bearer',
	}
}

test('OAuth provider saveTokens keeps a refresh token and discovery when the AS omits them', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')
	await provider.saveDiscoveryState({
		authorization_servers: ['https://auth.example'],
	} as never)
	await provider.saveTokens(bearer('first-at', 'keep-rt'))
	expect(values.get(tokenKey)).toEqual(bearer('first-at', 'keep-rt'))
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'keep-rt' })

	await provider.saveTokens(bearer('refreshed-at'))
	expect(values.get(tokenKey)).toEqual(bearer('refreshed-at', 'keep-rt'))
	expect(values.get('/Kody/server-home/oauth_discovery')).toEqual({
		authorization_servers: ['https://auth.example'],
	})

	await Promise.all([
		provider.saveTokens(bearer('race-a')),
		provider.saveTokens(bearer('race-b')),
	])
	expect(values.get(tokenKey)).toMatchObject({ refresh_token: 'keep-rt' })

	const restored = makeProvider(storage)
	expect(await restored.tokens()).toMatchObject({ refresh_token: 'keep-rt' })
	expect(restored.clientId).toBe('client-1')

	await restored.invalidateCredentials('tokens')
	expect(values.get(tokenKey)).toBeUndefined()
	expect(values.get(refreshKey)).toBeUndefined()
	expect(await restored.tokens()).toBeUndefined()
})

test('OAuth invalidate infers a missing client id, drops leftover token blobs, and keeps a newer rotated grant', async () => {
	const { storage, values, hooks } = createMemoryStorage()
	await makeProvider(storage, 'client-1').saveTokens(bearer('old-at', 'old-rt'))
	values.set(
		'/Kody/server-home/client-stale/token',
		bearer('stale-at', 'stale-rt'),
	)

	const restored = makeProvider(storage)
	await restored.invalidateCredentials('tokens')
	expect(values.get(tokenKey)).toBeUndefined()
	expect(values.get('/Kody/server-home/client-stale/token')).toBeUndefined()
	expect(values.get(refreshKey)).toBeUndefined()
	expect(await restored.tokens()).toBeUndefined()

	const rotating = makeProvider(storage, 'client-1')
	await rotating.saveTokens(bearer('live-at', 'live-rt'))

	const { promise: blockSave, resolve: releaseSave } =
		Promise.withResolvers<void>()
	const { promise: saveStarted, resolve: markSaveStarted } =
		Promise.withResolvers<void>()
	hooks.afterPut = async (key, value) => {
		if (
			key === refreshKey &&
			(value as { refresh_token?: string } | undefined)?.refresh_token ===
				'rotated-rt'
		) {
			markSaveStarted()
			await blockSave
		}
	}

	const saveRotated = rotating.saveTokens(bearer('rotated-at', 'rotated-rt'))
	await saveStarted
	const staleInvalidate = rotating.invalidateCredentials('tokens')
	releaseSave()
	await Promise.all([saveRotated, staleInvalidate])

	expect(values.get(tokenKey)).toMatchObject({
		access_token: 'rotated-at',
		refresh_token: 'rotated-rt',
	})
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'rotated-rt' })
	expect(await rotating.tokens()).toMatchObject({
		refresh_token: 'rotated-rt',
	})
})

test('client mode reads the client_id the authorization URL carries', () => {
	const authorize = (clientId: string) =>
		`https://auth.example/authorize?${new URLSearchParams({ client_id: clientId, state: 'nonce.server-home' })}`
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize(
				`https://kody.codes${mcpClientIdMetadataPath}`,
			),
			callbackUrl,
		}),
	).toBe('cimd')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize('registered-client-1'),
			callbackUrl,
		}),
	).toBe('dcr')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize(
				`https://kody.codes${mcpClientIdMetadataPath}`,
			),
			callbackUrl: 'http://localhost:8787/account/mcp-servers/oauth/callback',
		}),
	).toBe('dcr')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize('github-app-client'),
			callbackUrl,
			preRegisteredClientId: 'github-app-client',
		}),
	).toBe('pre-registered')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize('registered-client-1'),
			callbackUrl,
			preRegisteredClientId: 'github-app-client',
		}),
	).toBe('dcr')
})

const discoveryOnIssuer = {
	authorizationServerUrl: 'https://auth.example',
	authorizationServerMetadata: {
		issuer: 'https://auth.example',
		authorization_endpoint: 'https://auth.example/authorize',
		token_endpoint: 'https://auth.example/token',
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
	},
}

function asDiscoveryMetadata(overrides: Record<string, unknown> = {}) {
	return {
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			...overrides,
		},
	}
}

test('OAuth provider refuses discovery whose authorize or token endpoint leaves the issuer origin (#3284)', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')

	await expect(
		provider.saveDiscoveryState(
			asDiscoveryMetadata({
				authorization_endpoint: 'https://evil.example/authorize',
			}) as never,
		),
	).rejects.toThrow(McpOAuthFailedError)
	await expect(
		provider.saveDiscoveryState(
			asDiscoveryMetadata({
				token_endpoint: 'https://evil.example/token',
			}) as never,
		),
	).rejects.toThrow(
		new RegExp(
			`${mcpOAuthFailedCode}[\\s\\S]*token_endpoint .*different origin`,
		),
	)
	expect(values.get('/Kody/server-home/oauth_discovery')).toBeUndefined()

	await provider.saveDiscoveryState(asDiscoveryMetadata() as never)
	expect(values.get('/Kody/server-home/oauth_discovery')).toMatchObject({
		authorizationServerUrl: 'https://auth.example',
	})
})

test('OAuth provider refresh path re-asserts issuer origin on cached discovery (#3284)', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')
	// Pre-check / tampered cache: write past saveDiscoveryState.
	values.set(
		'/Kody/server-home/oauth_discovery',
		asDiscoveryMetadata({
			token_endpoint: 'https://evil.example/token',
		}),
	)

	await expect(provider.discoveryState()).rejects.toThrow(
		new RegExp(
			`${mcpOAuthFailedCode}[\\s\\S]*token_endpoint .*different origin`,
		),
	)
})

test('OAuth attempt identity: happy path, remove/re-add, client mismatch, and refresh without pending', async () => {
	const { storage, values } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'docs',
	}
	let currentLive: typeof live | null = { ...live }
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'

	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	expect(pending).not.toBeNull()
	await provider.saveDiscoveryState(discoveryOnIssuer as never)
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	await provider.saveTokens(bearer('grant-at', 'grant-rt'))
	expect(values.get(tokenKey)).toEqual(bearer('grant-at', 'grant-rt'))
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toBeUndefined()
	expect(
		values.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toBeUndefined()

	// Refresh / later saves without a pending attempt still work (existing grants).
	await provider.saveTokens(bearer('refreshed-at'))
	expect(values.get(tokenKey)).toEqual(bearer('refreshed-at', 'grant-rt'))

	// Refresh while an attempt is pending (not yet verified) must not clear it.
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await provider.saveTokens(bearer('refresh-during-attempt'))
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toEqual(pending)

	// Remove and re-add mid-flow: new stable id, nothing saved from the old attempt.
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	currentLive = {
		...live,
		serverId: 'server-readded',
	}
	await expect(
		provider.saveTokens(bearer('stolen-at', 'stolen-rt')),
	).rejects.toBeInstanceOf(McpOAuthAttemptIdentityError)
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toBeUndefined()

	// Client replaced mid-flow.
	currentLive = { ...live }
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	currentLive = { ...live, clientId: 'other-client' }
	await expect(
		provider.saveTokens(bearer('other-at', 'other-rt')),
	).rejects.toThrow(/Reconnect at \/account\/mcp-servers/)
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)

	// Person mismatch mid-flow.
	currentLive = { ...live }
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	currentLive = { ...live, personId: 'person-other' }
	await expect(
		provider.saveTokens(bearer('person-at', 'person-rt')),
	).rejects.toBeInstanceOf(McpOAuthAttemptIdentityError)
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)
})

test('checkState fails closed when the live server no longer matches the attempt', async () => {
	const { storage } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'docs',
	}
	let currentLive: typeof live | null = { ...live }
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	const state = await provider.state()
	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await provider.saveDiscoveryState(discoveryOnIssuer as never)

	expect(await provider.checkState(state)).toMatchObject({
		valid: true,
		serverId: 'server-home',
	})
	expect(
		await storage.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toMatchObject({ verifiedAt: expect.any(Number) })

	currentLive = null
	const refused = await provider.checkState(state)
	expect(refused.valid).toBe(false)
	expect(refused.error).toMatch(/Reconnect at \/account\/mcp-servers/)
	expect(
		await storage.get(mcpOAuthAttemptStorageKey('server-home')),
	).toBeUndefined()
	expect(
		await storage.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toBeUndefined()
})

test('a verified pending attempt survives an actor-less refresh race during grant save', async () => {
	const { storage, values } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1' as string | null,
		personId: 'person-1' as string | null,
		name: 'docs',
	}
	let currentLive: typeof live | null = { ...live }
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId!,
		personId: live.personId!,
		discovery: discoveryOnIssuer,
	})
	await provider.saveDiscoveryState(discoveryOnIssuer as never)
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')

	// Actor-less refresh (no ownerOrgId/personId) during the verified window.
	currentLive = { ...live, ownerOrgId: null, personId: null }
	await expect(
		provider.saveTokens(bearer('refresh-at')),
	).rejects.toBeInstanceOf(McpOAuthAttemptIdentityError)
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toEqual(pending)
	expect(
		values.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toMatchObject({ verifiedAt: expect.any(Number) })

	currentLive = { ...live }
	await provider.saveTokens(bearer('grant-at', 'grant-rt'))
	expect(values.get(tokenKey)).toEqual(bearer('grant-at', 'grant-rt'))
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toBeUndefined()
})

test('checkState refuses when a concurrent redirect replaces the pending attempt', async () => {
	const { storage } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'docs',
	}
	const original = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	const replaced = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: 'client-replaced',
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	await writeMcpOAuthAttemptIdentity(storage, original!)
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => {
			await writeMcpOAuthAttemptIdentity(storage, replaced!)
			return { ...live, clientId: 'client-replaced' }
		},
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	await provider.saveDiscoveryState(discoveryOnIssuer as never)
	const state = await provider.state()

	const refused = await provider.checkState(state)
	expect(refused.valid).toBe(false)
	expect(refused.error).toMatch(/Reconnect at \/account\/mcp-servers/)
	expect(
		await storage.get(mcpOAuthAttemptStorageKey('server-home')),
	).toBeUndefined()
	expect(
		await storage.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toBeUndefined()
})
