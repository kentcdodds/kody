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
