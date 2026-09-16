import { expect, test } from 'vitest'
import {
	buildMcpClientIdMetadataDocument,
	createMcpClientOAuthProvider,
	handleMcpClientIdMetadataRequest,
	mcpClientIdMetadataPath,
	mcpClientName,
	resolveMcpClientMetadataUrl,
} from './client-id-metadata.ts'
import { mcpOAuthRefreshTokenStorageKey } from './oauth-token-recovery.ts'

test('CIMD resolves only for HTTPS, serves the origin-bound document, and wires the OAuth provider', async () => {
	const origin = 'https://kody.codes'
	const documentUrl = `${origin}${mcpClientIdMetadataPath}`
	expect(
		resolveMcpClientMetadataUrl(`${origin}/account/mcp-servers/oauth/callback`),
	).toBe(documentUrl)
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
	expect(document.redirect_uris).toEqual([
		`${origin}/account/mcp-servers/oauth/callback`,
	])
	expect(document.token_endpoint_auth_method).toBe('none')

	const getResponse = handleMcpClientIdMetadataRequest(new Request(documentUrl))
	expect(getResponse?.status).toBe(200)
	expect(getResponse?.headers.get('Content-Type')).toBe('application/json')
	const body = (await getResponse?.json()) as {
		client_id: string
		redirect_uris: Array<string>
	}
	expect(body.client_id).toBe(documentUrl)
	expect(body.redirect_uris).toEqual([
		`${origin}/account/mcp-servers/oauth/callback`,
	])

	const headResponse = handleMcpClientIdMetadataRequest(
		new Request(documentUrl, { method: 'HEAD' }),
	)
	expect(headResponse?.status).toBe(200)
	expect(await headResponse?.text()).toBe('')

	expect(
		handleMcpClientIdMetadataRequest(
			new Request(documentUrl, { method: 'OPTIONS' }),
		)?.status,
	).toBe(204)
	expect(
		handleMcpClientIdMetadataRequest(new Request(`${origin}/oauth/authorize`)),
	).toBeNull()
	expect(
		handleMcpClientIdMetadataRequest(
			new Request(documentUrl, { method: 'POST' }),
		),
	).toBeNull()

	const storage = {} as DurableObjectStorage
	const httpsProvider = createMcpClientOAuthProvider(
		storage,
		`${origin}/account/mcp-servers/oauth/callback`,
	)
	expect(httpsProvider.clientMetadataUrl).toBe(documentUrl)
	expect(httpsProvider.clientMetadata.redirect_uris).toEqual([
		`${origin}/account/mcp-servers/oauth/callback`,
	])

	const httpProvider = createMcpClientOAuthProvider(
		storage,
		'http://127.0.0.1:8787/account/mcp-servers/oauth/callback',
	)
	expect(httpProvider.clientMetadataUrl).toBeUndefined()
})

function createMemoryStorage() {
	const values = new Map<string, unknown>()
	const storage = {
		put: async (key: string, value: unknown) => {
			values.set(key, value)
		},
		get: async (key: string) => values.get(key),
		delete: async (key: string | Array<string>) => {
			for (const item of Array.isArray(key) ? key : [key]) {
				values.delete(item)
			}
		},
		list: async ({ prefix }: { prefix?: string } = {}) => {
			return new Map(
				[...values.entries()].filter(([key]) =>
					prefix ? key.startsWith(prefix) : true,
				),
			)
		},
	} as unknown as DurableObjectStorage
	return { storage, values }
}

test('OAuth provider saveTokens keeps a refresh token and discovery when the AS omits them', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = createMcpClientOAuthProvider(
		storage,
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	await provider.saveDiscoveryState({
		authorization_servers: ['https://auth.example'],
	} as never)
	await provider.saveTokens({
		access_token: 'first-at',
		refresh_token: 'keep-rt',
		token_type: 'Bearer',
	})
	expect(values.get('/Kody/server-home/client-1/token')).toEqual({
		access_token: 'first-at',
		refresh_token: 'keep-rt',
		token_type: 'Bearer',
	})
	expect(values.get(mcpOAuthRefreshTokenStorageKey('server-home'))).toEqual({
		refresh_token: 'keep-rt',
	})

	await provider.saveTokens({
		access_token: 'refreshed-at',
		token_type: 'Bearer',
	})
	expect(values.get('/Kody/server-home/client-1/token')).toEqual({
		access_token: 'refreshed-at',
		refresh_token: 'keep-rt',
		token_type: 'Bearer',
	})
	expect(values.get('/Kody/server-home/oauth_discovery')).toEqual({
		authorization_servers: ['https://auth.example'],
	})

	await Promise.all([
		provider.saveTokens({ access_token: 'race-a', token_type: 'Bearer' }),
		provider.saveTokens({ access_token: 'race-b', token_type: 'Bearer' }),
	])
	const raced = values.get('/Kody/server-home/client-1/token') as {
		refresh_token?: string
	}
	expect(raced.refresh_token).toBe('keep-rt')

	const restored = createMcpClientOAuthProvider(
		storage,
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	restored.serverId = 'server-home'
	expect(await restored.tokens()).toMatchObject({
		refresh_token: 'keep-rt',
	})
	expect(restored.clientId).toBe('client-1')

	await restored.invalidateCredentials('tokens')
	expect(values.get('/Kody/server-home/client-1/token')).toBeUndefined()
	expect(
		values.get(mcpOAuthRefreshTokenStorageKey('server-home')),
	).toBeUndefined()
	expect(await restored.tokens()).toBeUndefined()
})

test('OAuth invalidate infers a missing client id, drops leftover token blobs, and keeps a newer rotated grant', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = createMcpClientOAuthProvider(
		storage,
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	await provider.saveTokens({
		access_token: 'old-at',
		refresh_token: 'old-rt',
		token_type: 'Bearer',
	})
	values.set('/Kody/server-home/client-stale/token', {
		access_token: 'stale-at',
		refresh_token: 'stale-rt',
		token_type: 'Bearer',
	})

	const restored = createMcpClientOAuthProvider(
		storage,
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	restored.serverId = 'server-home'
	await restored.invalidateCredentials('tokens')
	expect(values.get('/Kody/server-home/client-1/token')).toBeUndefined()
	expect(values.get('/Kody/server-home/client-stale/token')).toBeUndefined()
	expect(
		values.get(mcpOAuthRefreshTokenStorageKey('server-home')),
	).toBeUndefined()
	expect(await restored.tokens()).toBeUndefined()

	const rotating = createMcpClientOAuthProvider(
		storage,
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	rotating.serverId = 'server-home'
	rotating.clientId = 'client-1'
	await rotating.saveTokens({
		access_token: 'live-at',
		refresh_token: 'live-rt',
		token_type: 'Bearer',
	})

	let releaseSave: () => void = () => {}
	let markSaveStarted: () => void = () => {}
	const blockSave = new Promise<void>((resolve) => {
		releaseSave = resolve
	})
	const saveStarted = new Promise<void>((resolve) => {
		markSaveStarted = resolve
	})
	const originalPut = storage.put.bind(storage)
	storage.put = async (key, value) => {
		const written = await originalPut(key, value)
		if (
			typeof key === 'string' &&
			key === mcpOAuthRefreshTokenStorageKey('server-home') &&
			value &&
			typeof value === 'object' &&
			'refresh_token' in value &&
			value.refresh_token === 'rotated-rt'
		) {
			markSaveStarted()
			await blockSave
		}
		return written
	}

	const saveRotated = rotating.saveTokens({
		access_token: 'rotated-at',
		refresh_token: 'rotated-rt',
		token_type: 'Bearer',
	})
	await saveStarted
	const staleInvalidate = rotating.invalidateCredentials('tokens')
	releaseSave()
	await Promise.all([saveRotated, staleInvalidate])

	expect(values.get('/Kody/server-home/client-1/token')).toMatchObject({
		access_token: 'rotated-at',
		refresh_token: 'rotated-rt',
	})
	expect(values.get(mcpOAuthRefreshTokenStorageKey('server-home'))).toEqual({
		refresh_token: 'rotated-rt',
	})
	expect(await rotating.tokens()).toMatchObject({
		refresh_token: 'rotated-rt',
	})
})
