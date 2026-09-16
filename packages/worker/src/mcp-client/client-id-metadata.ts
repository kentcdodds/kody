import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider'
import {
	clientIdFromMcpOAuthTokenStorageKey,
	mcpOAuthRefreshTokenStorageKey,
	mcpOAuthServerStoragePrefix,
	parseStoredMcpOAuthRefreshToken,
	restoreReadableMcpOAuthTokens,
	withPreservedMcpOAuthRefreshToken,
} from './oauth-token-recovery.ts'

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

type McpOAuthTokenContext = Parameters<
	DurableObjectOAuthClientProvider['tokens']
>[0]
type McpOAuthStoredTokens = Awaited<
	ReturnType<DurableObjectOAuthClientProvider['tokens']>
>
type McpOAuthSaveTokens = Parameters<
	DurableObjectOAuthClientProvider['saveTokens']
>[0]

/**
 * Agents SDK storage/PKCE provider plus the MCP SDK `clientMetadataUrl`
 * hook. HTTPS callbacks present CIMD; http (local dev) omits it so auth
 * falls back to DCR. `saveTokens` keeps an existing refresh token when
 * the authorization server omits one, writes a server-scoped sidecar so
 * restore can find it when SQL `client_id` is missing, and keeps OAuth
 * discovery so the next authorize URL can still advertise scopes.
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
	const invalidateCredentials =
		typeof provider.invalidateCredentials === 'function'
			? provider.invalidateCredentials.bind(provider)
			: null
	let saveQueue = Promise.resolve()
	provider.tokens = async (context) => {
		const stored = await collectStoredMcpOAuthTokenSources(provider)
		if (!readProviderString(provider, 'clientId') && stored.clientId) {
			provider.clientId = stored.clientId
		}
		const blob = await readTokens(context).catch(() => undefined)
		return restoreReadableMcpOAuthTokens({
			blob,
			sources: stored.sources,
		}) as McpOAuthStoredTokens
	}
	provider.saveTokens = async (incoming, context) => {
		const run = saveQueue.then(() =>
			savePreservedMcpOAuthTokens({
				provider,
				incoming,
				context,
				saveTokens,
				readTokens,
				readDiscovery,
				writeDiscovery,
			}),
		)
		saveQueue = run.then(
			() => {},
			() => {},
		)
		return run
	}
	if (invalidateCredentials) {
		provider.invalidateCredentials = async (scope) => {
			await invalidateCredentials(scope)
			if (scope !== 'all' && scope !== 'client') return
			const serverId = readProviderString(provider, 'serverId')
			if (!serverId) return
			await provider.storage.delete(mcpOAuthRefreshTokenStorageKey(serverId))
		}
	}
}

async function savePreservedMcpOAuthTokens(input: {
	provider: DurableObjectOAuthClientProvider
	incoming: McpOAuthSaveTokens
	context: McpOAuthTokenContext
	saveTokens: DurableObjectOAuthClientProvider['saveTokens']
	readTokens: DurableObjectOAuthClientProvider['tokens']
	readDiscovery: DurableObjectOAuthClientProvider['discoveryState']
	writeDiscovery: DurableObjectOAuthClientProvider['saveDiscoveryState']
}) {
	const stored = await collectStoredMcpOAuthTokenSources(input.provider)
	if (!readProviderString(input.provider, 'clientId') && stored.clientId) {
		input.provider.clientId = stored.clientId
	}
	const [existing, discovery] = await Promise.all([
		input.readTokens(input.context).catch(() => undefined),
		input.readDiscovery(),
	])
	const merged = withPreservedMcpOAuthRefreshToken({
		incoming: input.incoming,
		sources: [existing, ...stored.sources],
	})
	await input.saveTokens(
		merged && typeof merged === 'object'
			? (merged as McpOAuthSaveTokens)
			: input.incoming,
		input.context,
	)
	const serverId = readProviderString(input.provider, 'serverId')
	const refreshToken = parseStoredMcpOAuthRefreshToken(merged)
	if (serverId && refreshToken) {
		await input.provider.storage.put(mcpOAuthRefreshTokenStorageKey(serverId), {
			refresh_token: refreshToken,
		})
	}
	if (discovery !== undefined) {
		await input.writeDiscovery(discovery)
	}
}

async function collectStoredMcpOAuthTokenSources(
	provider: DurableObjectOAuthClientProvider,
) {
	const serverId = readProviderString(provider, 'serverId')
	if (!serverId) {
		return { sources: [] as Array<unknown>, clientId: null as string | null }
	}
	const sidecar = parseStoredMcpOAuthRefreshToken(
		await provider.storage.get(mcpOAuthRefreshTokenStorageKey(serverId)),
	)
	const prefix = mcpOAuthServerStoragePrefix({
		clientName: mcpClientName,
		serverId,
	})
	const entries = await provider.storage.list({ prefix })
	const siblings: Array<unknown> = []
	let inferredClientId: string | null = null
	for (const [key, value] of entries) {
		const clientId = clientIdFromMcpOAuthTokenStorageKey({
			clientName: mcpClientName,
			serverId,
			key,
		})
		if (!clientId) continue
		siblings.push(value)
		inferredClientId ??= clientId
	}
	return {
		sources: [sidecar ? { refresh_token: sidecar } : null, ...siblings].filter(
			(source) => source != null,
		),
		clientId: inferredClientId,
	}
}

function readProviderString(
	provider: DurableObjectOAuthClientProvider,
	key: 'serverId' | 'clientId',
) {
	try {
		const value = provider[key]
		return typeof value === 'string' && value.trim().length > 0 ? value : null
	} catch {
		return null
	}
}
