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
	expect(await rotating.tokens()).toMatchObject({ refresh_token: 'rotated-rt' })
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
})
