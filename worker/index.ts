import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { ChatAgent } from '#worker/chat-agent.ts'
import { MCP } from '#mcp/index.ts'
import { chatAgentBasePath } from '#shared/chat-routes.ts'
import { handleRequest } from '#server/handler.ts'
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
} from './mcp-auth.ts'
import { withCors } from './utils.ts'

export { ChatAgent, MCP }

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
			return handleProtectedResourceMetadata(request)
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

		// Dev route: serve calculator UI for iframe testing (simulates ChatGPT/MCP Jam)
		if (
			url.pathname === '/dev/calculator-ui' &&
			(request.method === 'GET' || request.method === 'HEAD')
		) {
			const { renderCalculatorUiEntryPoint } =
				await import('#mcp/apps/calculator-ui-entry-point.ts')
			const baseUrl = new URL('/', url.origin)
			const html = renderCalculatorUiEntryPoint(baseUrl)
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

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return oauthProvider.fetch(request, env, ctx)
	},
} satisfies ExportedHandler<Env>
