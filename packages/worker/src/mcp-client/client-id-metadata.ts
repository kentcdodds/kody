import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider'
import { mergeMcpOAuthTokens } from './oauth-token-recovery.ts'

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

type McpClientOAuthProvider = DurableObjectOAuthClientProvider & {
	clientMetadataUrl?: string
}

/**
 * Agents SDK storage/PKCE provider plus the MCP SDK `clientMetadataUrl`
 * hook. HTTPS callbacks present CIMD; http (local dev) omits it so auth
 * falls back to DCR. `saveTokens` keeps an existing refresh token when
 * the authorization server omits one, and keeps OAuth discovery so the
 * next authorize URL can still advertise scopes.
 */
export function createMcpClientOAuthProvider(
	storage: DurableObjectStorage,
	callbackUrl: string,
) {
	const provider = new DurableObjectOAuthClientProvider(
		storage,
		mcpClientName,
		callbackUrl,
	) as McpClientOAuthProvider
	installMcpOAuthTokenPreservation(provider)
	const clientMetadataUrl = resolveMcpClientMetadataUrl(callbackUrl)
	if (clientMetadataUrl) {
		provider.clientMetadataUrl = clientMetadataUrl
	}
	return provider
}

function installMcpOAuthTokenPreservation(
	provider: DurableObjectOAuthClientProvider,
) {
	if (
		typeof provider.saveTokens !== 'function' ||
		typeof provider.tokens !== 'function' ||
		typeof provider.discoveryState !== 'function' ||
		typeof provider.saveDiscoveryState !== 'function'
	) {
		return
	}
	const saveTokens = provider.saveTokens.bind(provider)
	const readTokens = provider.tokens.bind(provider)
	const readDiscovery = provider.discoveryState.bind(provider)
	const writeDiscovery = provider.saveDiscoveryState.bind(provider)
	provider.saveTokens = async (incoming, context) => {
		const [existing, discovery] = await Promise.all([
			readTokens(context),
			readDiscovery(),
		])
		const merged = mergeMcpOAuthTokens({ incoming, existing })
		await saveTokens(
			merged && typeof merged === 'object'
				? (merged as typeof incoming)
				: incoming,
			context,
		)
		if (discovery !== undefined) {
			await writeDiscovery(discovery)
		}
	}
}
