import * as Sentry from '@sentry/cloudflare'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { ChatAgent } from './chat-agent.ts'
import { HomeConnectorSession } from './home/session.ts'
import { HomeMCP } from './home/mcp.ts'
import { MCP } from './mcp/index.ts'
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
import { withCors } from './utils.ts'
import { handleCapabilityReindexRequest } from './capability-maintenance.ts'
import { handleSkillReindexRequest } from './skill-maintenance.ts'

export { ChatAgent, HomeConnectorSession, HomeMCP, MCP }

const appHandler = withCors({
	getCorsHeaders(request) {
		const origin = request.headers.get('Origin')
		if (!origin) return null
		const requestOrigin = new URL(request.url).origin
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

		if (url.pathname.startsWith('/home/connectors/')) {
			const parts = url.pathname.split('/').filter(Boolean)
			const connectorId = parts[2]?.trim()
			if (!connectorId) {
				return new Response('Connector ID is required.', { status: 400 })
			}
			const stub = env.HOME_CONNECTOR_SESSION.get(
				env.HOME_CONNECTOR_SESSION.idFromName(connectorId),
			)
			return stub.fetch(request)
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

		// Dev route: serve generated UI shell for iframe testing (simulates ChatGPT/MCP Jam)
		if (
			url.pathname === '/dev/generated-ui' &&
			(request.method === 'GET' || request.method === 'HEAD')
		) {
			const { renderGeneratedUiShellEntryPoint } =
				await import('./mcp/apps/generated-ui-shell-entry-point.ts')
			const baseUrl = new URL('/', url.origin)
			const html = renderGeneratedUiShellEntryPoint(baseUrl)
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
				const metadataResponse =
					handleProtectedResourceMetadata(metadataRequest, env)
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
