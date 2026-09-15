import { expect, test } from 'vitest'
import {
	buildMcpClientIdMetadataDocument,
	createMcpClientOAuthProvider,
	handleMcpClientIdMetadataRequest,
	mcpClientIdMetadataPath,
	mcpClientName,
	resolveMcpClientMetadataUrl,
} from './client-id-metadata.ts'

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

test('OAuth provider saveTokens keeps a refresh token and discovery when the AS omits them', async () => {
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
		list: async () => new Map(),
	} as unknown as DurableObjectStorage
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
})
