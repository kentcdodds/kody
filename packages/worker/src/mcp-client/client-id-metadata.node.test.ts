import { expect, test } from 'vitest'
import {
	buildMcpClientIdMetadataDocument,
	createMcpClientOAuthProvider,
	handleMcpClientIdMetadataRequest,
	mcpClientIdMetadataPath,
	mcpClientName,
	resolveMcpClientMetadataUrl,
} from './client-id-metadata.ts'

test('CIMD document is self-describing for the request origin', () => {
	const origin = 'https://kody.codes'
	const document = buildMcpClientIdMetadataDocument(`${origin}/ignored`)
	expect(document).toEqual({
		client_id: `${origin}${mcpClientIdMetadataPath}`,
		client_name: mcpClientName,
		client_uri: origin,
		logo_uri: `${origin}/logo.png`,
		redirect_uris: [`${origin}/account/mcp-servers/oauth/callback`],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
	})
	expect(document.client_id).toBe(
		`${document.client_uri}${mcpClientIdMetadataPath}`,
	)
})

test('CIMD URL is HTTPS-only so local http falls back to DCR', () => {
	expect(
		resolveMcpClientMetadataUrl(
			'https://kody.codes/account/mcp-servers/oauth/callback',
		),
	).toBe('https://kody.codes/oauth/client-metadata.json')
	expect(
		resolveMcpClientMetadataUrl(
			'http://localhost:8787/account/mcp-servers/oauth/callback',
		),
	).toBeUndefined()
	expect(resolveMcpClientMetadataUrl('not-a-url')).toBeUndefined()
})

test('CIMD route serves JSON, HEAD, and OPTIONS for the request origin', async () => {
	const documentUrl = `https://preview.example${mcpClientIdMetadataPath}`
	const getResponse = handleMcpClientIdMetadataRequest(new Request(documentUrl))
	expect(getResponse?.status).toBe(200)
	expect(getResponse?.headers.get('Content-Type')).toBe('application/json')
	const body = (await getResponse?.json()) as {
		client_id: string
		redirect_uris: Array<string>
	}
	expect(body.client_id).toBe(documentUrl)
	expect(body.redirect_uris).toEqual([
		'https://preview.example/account/mcp-servers/oauth/callback',
	])

	const headResponse = handleMcpClientIdMetadataRequest(
		new Request(documentUrl, { method: 'HEAD' }),
	)
	expect(headResponse?.status).toBe(200)
	expect(headResponse?.headers.get('Content-Type')).toBe('application/json')
	expect(await headResponse?.text()).toBe('')

	const optionsResponse = handleMcpClientIdMetadataRequest(
		new Request(documentUrl, { method: 'OPTIONS' }),
	)
	expect(optionsResponse?.status).toBe(204)

	expect(
		handleMcpClientIdMetadataRequest(
			new Request('https://preview.example/oauth/authorize'),
		),
	).toBeNull()
	expect(
		handleMcpClientIdMetadataRequest(
			new Request(documentUrl, { method: 'POST' }),
		),
	).toBeNull()
})

test('OAuth provider presents CIMD on https callbacks and omits it on http', () => {
	const storage = {} as DurableObjectStorage
	const httpsProvider = createMcpClientOAuthProvider(
		storage,
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	expect(httpsProvider.clientMetadataUrl).toBe(
		'https://kody.codes/oauth/client-metadata.json',
	)
	expect(httpsProvider.clientMetadata.client_name).toBe(mcpClientName)
	expect(httpsProvider.clientMetadata.redirect_uris).toEqual([
		'https://kody.codes/account/mcp-servers/oauth/callback',
	])

	const httpProvider = createMcpClientOAuthProvider(
		storage,
		'http://127.0.0.1:8787/account/mcp-servers/oauth/callback',
	)
	expect(httpProvider.clientMetadataUrl).toBeUndefined()
})
