import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider'

export const mcpClientIdMetadataPath = '/oauth/client-metadata.json'
export const mcpServerOAuthCallbackPath = '/account/mcp-servers/oauth/callback'
export const mcpClientName = 'Kody'

/**
 * MCP clients MUST host CIMD at an HTTPS URL with a path. Local http
 * origins stay on DCR: the SDK only uses `clientMetadataUrl` when the
 * authorization server advertises CIMD support *and* this URL is HTTPS.
 */
export function resolveMcpClientMetadataUrl(callbackUrl: string) {
	try {
		const url = new URL(mcpClientIdMetadataPath, callbackUrl)
		if (url.protocol !== 'https:') return undefined
		return url.href
	} catch {
		return undefined
	}
}

export function buildMcpClientIdMetadataDocument(origin: string) {
	const clientOrigin = new URL(origin).origin
	const clientId = `${clientOrigin}${mcpClientIdMetadataPath}`
	return {
		client_id: clientId,
		client_name: mcpClientName,
		client_uri: clientOrigin,
		logo_uri: `${clientOrigin}/logo.png`,
		redirect_uris: [`${clientOrigin}${mcpServerOAuthCallbackPath}`],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
	}
}

export function isMcpClientIdMetadataRequest(pathname: string) {
	return pathname === mcpClientIdMetadataPath
}

export function handleMcpClientIdMetadataRequest(request: Request) {
	const url = new URL(request.url)
	if (!isMcpClientIdMetadataRequest(url.pathname)) return null
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: { 'Content-Length': '0' },
		})
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') return null

	const body = JSON.stringify(buildMcpClientIdMetadataDocument(url.origin))
	const headers = {
		'Content-Type': 'application/json',
		'Cache-Control': 'public, max-age=3600',
	}
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return new Response(body, { headers })
}

/**
 * Agents SDK storage/PKCE provider plus the MCP SDK `clientMetadataUrl`
 * hook. HTTPS callbacks present CIMD; http (local dev) omits it so auth
 * falls back to DCR.
 */
export function createMcpClientOAuthProvider(
	storage: DurableObjectStorage,
	callbackUrl: string,
) {
	const provider = new DurableObjectOAuthClientProvider(
		storage,
		mcpClientName,
		callbackUrl,
	) as DurableObjectOAuthClientProvider & { clientMetadataUrl?: string }
	const clientMetadataUrl = resolveMcpClientMetadataUrl(callbackUrl)
	if (clientMetadataUrl) {
		provider.clientMetadataUrl = clientMetadataUrl
	}
	return provider
}
