import * as Sentry from '@sentry/cloudflare'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { ChatAgent } from './chat-agent.ts'
import { HomeConnectorSession } from './home/session.ts'
import { HomeMCP } from './home/mcp.ts'
import { MCP } from './mcp/index.ts'
import { AppFacetBridge, AppRunner } from './mcp/app-runner.ts'
import { JobManager } from './jobs/manager-do.ts'
import { StorageRunner } from './storage-runner.ts'
import { AgentTurnRunner } from './agent-turn/runner-do.ts'
import { RepoSession } from './repo/repo-session-do.ts'
import { chatAgentBasePath } from '@kody-internal/shared/chat-routes.ts'
import { getWorkerSentryOptions } from './sentry-options.ts'
import { handleRequest } from '#app/handler.ts'
import { handleChatAgentRequest } from './chat-agent-routing.ts'
import {
	apiHandler,
	handleAuthorizeRequest,
	handleAuthorizeInfo,
	handleOAuthCallback,
	oauthPaths,
	oauthScopes,
} from './oauth-handlers.ts'
import {
	handleMcpRequest,
	handleProtectedResourceMetadata,
	isProtectedResourceMetadataRequest,
	mcpResourcePath,
	protectedResourceMetadataPath,
} from './mcp-auth.ts'
import {
	handleGeneratedUiApiRequest,
	isGeneratedUiApiRequest,
} from './mcp/generated-ui-api.ts'
import { readGeneratedUiAppBackendSession } from './mcp/generated-ui-app-auth.ts'
import { withCors } from './utils.ts'
import { handleCapabilityReindexRequest } from './capability-maintenance.ts'
import { handleJobReindexRequest } from './job-maintenance.ts'
import { handleMemoryReindexRequest } from './memory-maintenance.ts'
import { handleSkillReindexRequest } from './skill-maintenance.ts'
import { handleUiArtifactReindexRequest } from './ui-artifact-maintenance.ts'
import { CodemodeFetchGateway } from '#mcp/fetch-gateway.ts'
import {
	connectorSessionKey,
	parseConnectorRoutePath,
} from './remote-connector/connector-session-key.ts'

export {
	ChatAgent,
	AgentTurnRunner,
	RepoSession,
	CodemodeFetchGateway,
	HomeConnectorSession,
	HomeMCP,
	MCP,
	AppFacetBridge,
	AppRunner,
	JobManager,
	StorageRunner,
}

const claudeWidgetDomainSuffix = '.claudemcpcontent.com'

function isAllowedGeneratedUiOrigin(origin: string, requestOrigin: string) {
	if (origin === requestOrigin) {
		return true
	}
	try {
		const parsedOrigin = new URL(origin)
		return parsedOrigin.hostname.endsWith(claudeWidgetDomainSuffix)
	} catch {
		return false
	}
}

const appHandler = withCors({
	getCorsHeaders(request) {
		const url = new URL(request.url)
		if (isGeneratedUiApiRequest(url.pathname)) {
			const origin = request.headers.get('Origin')
			if (!origin || !isAllowedGeneratedUiOrigin(origin, url.origin)) {
				return null
			}
			return {
				'Access-Control-Allow-Origin': origin,
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'content-type, authorization',
				Vary: 'Origin',
			}
		}
		const origin = request.headers.get('Origin')
		if (!origin) return null
		const requestOrigin = url.origin
		if (origin !== requestOrigin) return null
		return {
			'Access-Control-Allow-Origin': origin,
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'content-type, authorization',
			Vary: 'Origin',
		}
	},
	async handler(request, env, ctx) {
		const url = new URL(request.url)

		if (url.pathname === '/__maintenance/reindex-capabilities') {
			return handleCapabilityReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/reindex-skills') {
			return handleSkillReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/reindex-memories') {
			return handleMemoryReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/reindex-apps') {
			return handleUiArtifactReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/reindex-jobs') {
			return handleJobReindexRequest(request, env)
		}

		if (url.pathname === oauthPaths.authorize) {
			return handleAuthorizeRequest(request, env)
		}

		if (url.pathname === oauthPaths.authorizeInfo) {
			return handleAuthorizeInfo(request, env)
		}

		if (url.pathname === oauthPaths.callback) {
			return handleOAuthCallback(request)
		}

		if (url.pathname === '/.well-known/appspecific/com.chrome.devtools.json') {
			return new Response(null, { status: 204 })
		}

		if (isProtectedResourceMetadataRequest(url.pathname)) {
			return handleProtectedResourceMetadata(request, env)
		}

		if (url.pathname === mcpResourcePath) {
			return handleMcpRequest({
				request,
				env,
				ctx,
				fetchMcp: MCP.serve(mcpResourcePath, {
					binding: 'MCP_OBJECT',
				}).fetch,
			})
		}

		if (isGeneratedUiApiRequest(url.pathname)) {
			return handleGeneratedUiApiRequest(request, env)
		}

		if (url.pathname.startsWith('/app/')) {
			const [, , rawAppId, ...rest] = url.pathname.split('/')
			let appId = rawAppId?.trim()
			if (!appId) {
				return new Response('Not found.', { status: 404 })
			}
			try {
				appId = decodeURIComponent(appId)
			} catch {
				return new Response('Not found.', { status: 404 })
			}
			let auth: Awaited<
				ReturnType<typeof readGeneratedUiAppBackendSession>
			> | null = null
			try {
				auth = await readGeneratedUiAppBackendSession({
					request,
					env,
					appId,
				})
			} catch {
				return Response.json(
					{ ok: false, error: 'Unauthorized saved app backend request.' },
					{ status: 401 },
				)
			}
			if (!auth || auth.app_id !== appId) {
				return Response.json(
					{ ok: false, error: 'Unauthorized saved app backend request.' },
					{ status: 401 },
				)
			}
			const runner = ctx.exports.AppRunner.getByName(appId)
			const forwardedUrl = new URL(request.url)
			forwardedUrl.pathname = `/${rest.join('/')}`
			const forwardedRequest = new Request(forwardedUrl.toString(), request)
			forwardedRequest.headers.set('X-Kody-App-Id', appId)
			forwardedRequest.headers.set('X-Kody-App-User-Id', auth.user.userId)
			forwardedRequest.headers.set('X-Kody-App-Base-Url', forwardedUrl.origin)
			return await runner.fetch(forwardedRequest)
		}

		const connectorRoute = parseConnectorRoutePath(url.pathname)
		if (connectorRoute) {
			const sessionKey = connectorSessionKey(
				connectorRoute.kind,
				connectorRoute.instanceId,
			)
			const stub = env.HOME_CONNECTOR_SESSION.get(
				env.HOME_CONNECTOR_SESSION.idFromName(sessionKey),
			)
			const forwardUrl = new URL(request.url)
			forwardUrl.pathname = connectorRoute.rest || '/'
			const forwardRequest = new Request(forwardUrl.toString(), request)
			forwardRequest.headers.set('X-Kody-Connector-Session-Key', sessionKey)
			return stub.fetch(forwardRequest)
		}

		if (url.pathname.startsWith(`${chatAgentBasePath}/`)) {
			return handleChatAgentRequest(request, env)
		}

		// Sandboxed widget iframes have an opaque origin, so JS/CSS loads become CORS fetches.
		// ChatGPT/MCP Jam can render with sandbox="allow-scripts", which requires these headers.
		if (
			env.ASSETS &&
			(request.method === 'GET' || request.method === 'HEAD') &&
			(url.pathname.startsWith('/mcp-apps/') || url.pathname === '/styles.css')
		) {
			const assetResponse = await env.ASSETS.fetch(request)
			if (assetResponse.status !== 404) {
				const headers = new Headers(assetResponse.headers)
				headers.set('Access-Control-Allow-Origin', '*')
				return new Response(assetResponse.body, {
					status: assetResponse.status,
					statusText: assetResponse.statusText,
					headers,
				})
			}
		}

		// Dev route: serve generated UI runtime HTML entry for iframe testing.
		if (
			url.pathname === '/dev/generated-ui' &&
			(request.method === 'GET' || request.method === 'HEAD')
		) {
			const { renderGeneratedUiRuntimeHtmlEntry } =
				await import('./mcp/apps/generated-ui-runtime-html-entry.ts')
			const baseUrl = new URL('/', url.origin)
			const html = renderGeneratedUiRuntimeHtmlEntry(baseUrl)
			return new Response(html, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
				},
			})
		}

		// Try to serve static assets for safe methods only
		if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
			const response = await env.ASSETS.fetch(request)
			if (response.ok) {
				return response
			}
		}

		return handleRequest(request, env)
	},
})

const oauthProvider = new OAuthProvider({
	apiRoute: oauthPaths.apiPrefix,
	apiHandler,
	defaultHandler: {
		fetch(request, env, ctx) {
			// @ts-expect-error https://github.com/cloudflare/workers-oauth-provider/issues/71
			return appHandler(request, env, ctx)
		},
	},
	authorizeEndpoint: oauthPaths.authorize,
	tokenEndpoint: oauthPaths.token,
	clientRegistrationEndpoint: oauthPaths.register,
	scopesSupported: oauthScopes,
})

/**
 * Aligns with @cloudflare/workers-oauth-provider's addCorsHeaders for well-known routes.
 * (See OAuthProviderImpl.fetch in that package.)
 */
function addOAuthDiscoveryCorsHeaders(
	response: Response,
	request: Request,
): Response {
	const origin = request.headers.get('Origin')
	if (!origin) {
		return response
	}
	const headers = new Headers(response.headers)
	headers.set('Access-Control-Allow-Origin', origin)
	headers.set('Access-Control-Allow-Methods', '*')
	headers.set('Access-Control-Allow-Headers', 'Authorization, *')
	headers.set('Access-Control-Max-Age', '86400')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

const workerHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url)

		// OAuthProvider serves this URL first and defaults `resource` to the origin only.
		// MCP clients must use `<origin>/mcp` as the resource (RFC 8707) to match our
		// token audience; otherwise authorize stores origin but the token request sends
		// `/mcp` → invalid_target. Serve the same document as the `/mcp` metadata path.
		if (url.pathname === protectedResourceMetadataPath) {
			if (request.method === 'OPTIONS') {
				return addOAuthDiscoveryCorsHeaders(
					new Response(null, {
						status: 204,
						headers: { 'Content-Length': '0' },
					}),
					request,
				)
			}
			if (request.method === 'GET' || request.method === 'HEAD') {
				const metadataRequest =
					request.method === 'GET'
						? request
						: new Request(request.url, {
								method: 'GET',
								headers: request.headers,
							})
				const metadataResponse = handleProtectedResourceMetadata(
					metadataRequest,
					env,
				)
				if (request.method === 'HEAD') {
					return addOAuthDiscoveryCorsHeaders(
						new Response(null, {
							status: metadataResponse.status,
							headers: metadataResponse.headers,
						}),
						request,
					)
				}
				return addOAuthDiscoveryCorsHeaders(metadataResponse, request)
			}
		}
		return oauthProvider.fetch(request, env, ctx)
	},
} satisfies ExportedHandler<Env>

export default Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	workerHandler,
)
