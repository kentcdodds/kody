import * as Sentry from '@sentry/cloudflare'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { RemoteConnectorSession } from './remote-connector/session.ts'
import { McpClientHub } from './mcp-client/hub.ts'
import { MCP } from './mcp/index.ts'
import { JobManager } from './jobs/manager-do.ts'
import { StorageRunner } from './storage-runner.ts'
import { RunLog } from './run-records/run-log-do.ts'
import { UserMeter } from './entitlements/user-meter-do.ts'
import { StripePlanRefresh } from './billing/stripe-plan-refresh-do.ts'
import { Mailbox } from './email/mailbox-do.ts'
import { RepoSession } from './repo/repo-session-do.ts'
import { PackageRealtimeSession } from '#worker/package-runtime/realtime-session.ts'
import { PackageServiceInstance } from '#worker/package-runtime/package-service.ts'
import { DynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { getWorkerSentryOptions } from './sentry-options.ts'
import { handleRequest } from '#app/handler.ts'
import {
	apiHandler,
	handleAuthorizeRouteException,
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
	handlePackageInvocationApiRequest,
	isPackageInvocationApiRequest,
} from './package-invocations/http.ts'
import {
	handleWebhookIngressRequest,
	isWebhookIngressRequest,
} from './webhooks/http.ts'
import { withCors } from './utils.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { checkAuthRateLimit } from '#app/rate-limit.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { handleCapabilityReindexRequest } from './capability-maintenance.ts'
import { handleExecuteSmokeRequest } from './execute-maintenance.ts'
import { handleJobReindexRequest } from './job-maintenance.ts'
import { handleMemoryReindexRequest } from './memory-maintenance.ts'
import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import {
	parseUserScopedConnectorRoutePath,
	userScopedConnectorSessionKey,
} from './remote-connector/connector-session-key.ts'
import {
	handlePackageAppRequest,
	isPackageAppRequestPath,
} from '#app/handlers/package-app.ts'
import { handlePackageAppOriginRequest } from '#app/package-app-origin.ts'
import { PackageAppRuntimeBridge } from '#worker/package-runtime/package-app.ts'
import { handleInboundEmail } from '#worker/email/inbound.ts'
import { handleQueueBatch } from '#worker/queue-handler.ts'
import { findPublicUserIdentityByUsername } from '#worker/identity/user-lookup.ts'
import { dispatchScheduledLanes } from '#worker/scheduled/scheduled-dispatch-queue.ts'
import { handleDrRestoreRequest } from '#worker/dr/dr-restore.ts'
import { handleDrExportRequest } from '#worker/dr/dr-export-maintenance.ts'
import { handleDoPitrRequest } from '#worker/dr/do-pitr-maintenance.ts'
import { handleMailboxImportRequest } from '#worker/dr/mailbox-import-maintenance.ts'
import { OAuthPurgeCoordinator } from './oauth-purge.ts'
import { verifyPublicFormProtection } from '#app/public-form-protection.ts'
import { getLegacyHostRedirectResponse } from '#worker/app-legacy-redirect.ts'
import {
	isNamespacedAppEndpointPath,
	isNamespacedPackageInvocationEndpointPath,
} from '#worker/user-namespace-routes.ts'

export {
	RepoSession,
	KodyFetchGateway,
	RemoteConnectorSession,
	McpClientHub,
	MCP,
	JobManager,
	PackageRealtimeSession,
	PackageServiceInstance,
	DynamicCallableWorkflow,
	PackageAppRuntimeBridge,
	StorageRunner,
	RunLog,
	UserMeter,
	StripePlanRefresh,
	Mailbox,
	OAuthPurgeCoordinator,
}

// Immutable caching is only safe when asset URLs are versioned by a real
// commit sha. In local dev the build id falls back to a constant ('dev'), so
// an immutable header would pin browsers to a stale bundle across rebuilds.
function shouldApplyLongLivedAssetCaching(pathname: string, env: Env) {
	const commitSha = (env as { APP_COMMIT_SHA?: string }).APP_COMMIT_SHA?.trim()
	if (!commitSha) return false
	return (
		pathname === '/client-entry.js' ||
		pathname === '/styles.css' ||
		pathname.startsWith('/assets/')
	)
}

// Credential-accepting POST endpoints share one per-IP auth rate-limit bucket
// so brute-force attempts cannot fan out across parallel paths (password login,
// OAuth inline login, social-login starts, password-reset request/confirm,
// two-factor code verification and management, and passkey sign-in).
const socialLoginStartPaths = new Set([
	'/auth/github',
	'/auth/google',
	'/auth/x',
])

const rateLimitedAuthPaths = new Set([
	'/auth',
	...socialLoginStartPaths,
	'/oauth/authorize',
	'/password-reset',
	'/password-reset/confirm',
	'/verify/2fa.json',
	'/account/two-factor.json',
	'/webauthn/authentication',
])

const protectedPublicJsonFormPaths = new Set([
	'/verify/2fa.json',
	'/webauthn/authentication',
])

async function handleUserScopedConnectorRequest(request: Request, env: Env) {
	const url = new URL(request.url)
	const userScopedConnectorRoute = parseUserScopedConnectorRoutePath(
		url.pathname,
	)
	if (!userScopedConnectorRoute) return null
	if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
		return new Response('Not Found', { status: 404 })
	}
	const routeUser = await findPublicUserIdentityByUsername({
		db: env.APP_DB,
		username: userScopedConnectorRoute.username,
	})
	if (!routeUser) {
		return new Response('Not Found', { status: 404 })
	}
	const sessionKey = userScopedConnectorSessionKey({
		userId: routeUser.mcpUserId,
		instanceId: userScopedConnectorRoute.instanceId,
	})
	const stub = env.REMOTE_CONNECTOR_SESSION.get(
		env.REMOTE_CONNECTOR_SESSION.idFromName(sessionKey),
	)
	const forwardUrl = new URL(request.url)
	forwardUrl.pathname = userScopedConnectorRoute.rest || '/'
	const forwardRequest = new Request(forwardUrl.toString(), request)
	forwardRequest.headers.set('X-Kody-Connector-Session-Key', sessionKey)
	forwardRequest.headers.set('X-Kody-Connector-User-Id', routeUser.mcpUserId)
	return stub.fetch(forwardRequest)
}

const appHandler = withCors({
	getCorsHeaders(request): Record<string, string> | null {
		const url = new URL(request.url)
		const origin = request.headers.get('Origin')
		if (!origin) return null
		const requestOrigin = url.origin
		// Remote MCP clients in browser hosts (Gemini custom apps, etc.) call
		// `/mcp` cross-origin. Reflect any Origin and expose WWW-Authenticate so
		// the client can read the OAuth challenge; same-origin stays the default
		// for the rest of the app.
		if (
			url.pathname === mcpResourcePath ||
			url.pathname === `${mcpResourcePath}/`
		) {
			return {
				'Access-Control-Allow-Origin': origin,
				'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
				'Access-Control-Allow-Headers':
					'Authorization, Content-Type, Accept, MCP-Protocol-Version, Last-Event-ID, Mcp-Session-Id',
				'Access-Control-Expose-Headers':
					'WWW-Authenticate, MCP-Session-Id, Content-Type',
				Vary: 'Origin',
			}
		}
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

		if (request.method === 'POST' && rateLimitedAuthPaths.has(url.pathname)) {
			const ip = getRequestIp(request) ?? 'unknown'
			const rateLimitKey = `auth:ip:${ip}`
			const result = await checkAuthRateLimit(env, rateLimitKey)
			if (!result.allowed) {
				// A non-JSON social-login start is a document navigation, so a
				// JSON 429 body would render as raw text; bounce back to the
				// login page instead. 303 forces a GET. (The first-party UI
				// sends Accept: application/json and gets the JSON 429.)
				const prefersJson = request.headers
					.get('Accept')
					?.toLowerCase()
					.includes('application/json')
				if (socialLoginStartPaths.has(url.pathname) && !prefersJson) {
					const loginUrl = new URL('/login', url)
					loginUrl.searchParams.set('oauthError', 'rate-limited')
					const redirectTo = normalizeRedirectTo(
						url.searchParams.get('redirectTo'),
					)
					if (redirectTo) {
						loginUrl.searchParams.set('redirectTo', redirectTo)
					}
					return new Response(null, {
						status: 303,
						headers: {
							Location: loginUrl.toString(),
							'Retry-After': String(result.retryAfterSeconds ?? 60),
						},
					})
				}
				return new Response(
					JSON.stringify({
						error: 'Too many requests. Please try again later.',
					}),
					{
						status: 429,
						headers: {
							'Content-Type': 'application/json',
							'Retry-After': String(result.retryAfterSeconds ?? 60),
						},
					},
				)
			}
		}

		if (
			request.method === 'POST' &&
			protectedPublicJsonFormPaths.has(url.pathname)
		) {
			const body = (await request
				.clone()
				.json()
				.catch(() => ({}))) as Record<string, unknown>
			const protection = await verifyPublicFormProtection({
				env,
				request,
				body: typeof body === 'object' && body !== null ? body : {},
			})
			if (!protection.ok) return protection.response
		}

		if (url.pathname === '/__maintenance/reindex-capabilities') {
			return handleCapabilityReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/execute-smoke') {
			return handleExecuteSmokeRequest(request, env)
		}

		if (url.pathname === '/__maintenance/reindex-memories') {
			return handleMemoryReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/reindex-jobs') {
			return handleJobReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/dr-restore') {
			return handleDrRestoreRequest(request, env)
		}

		if (url.pathname === '/__maintenance/dr-export') {
			return handleDrExportRequest(request, env)
		}

		if (url.pathname === '/__maintenance/do-pitr') {
			return handleDoPitrRequest(request, env)
		}

		if (url.pathname === '/__maintenance/dr-mailbox-import') {
			return handleMailboxImportRequest(request, env)
		}

		if (url.pathname.startsWith('/__maintenance/')) {
			return Response.json(
				{ error: 'Unknown maintenance endpoint.' },
				{ status: 404 },
			)
		}

		if (url.pathname === oauthPaths.authorize) {
			try {
				if (
					request.method === 'POST' &&
					request.headers
						.get('Content-Type')
						?.includes('application/x-www-form-urlencoded')
				) {
					const formData = await request.clone().formData()
					// Only the signed-out inline-login form accepts credentials.
					// Signed-in approval/denial posts remain protected by session
					// and OAuth request state rather than a public bot challenge.
					if (formData.has('email') || formData.has('password')) {
						const protection = await verifyPublicFormProtection({
							env,
							request,
							body: Object.fromEntries(formData),
						})
						if (!protection.ok) return protection.response
					}
				}
				return await handleAuthorizeRequest(request, env)
			} catch (error) {
				Sentry.captureException(error)
				return handleAuthorizeRouteException(request)
			}
		}

		if (url.pathname === oauthPaths.authorizeInfo) {
			try {
				return await handleAuthorizeInfo(request, env)
			} catch (error) {
				Sentry.captureException(error)
				return handleAuthorizeRouteException(request)
			}
		}

		if (url.pathname === oauthPaths.callback) {
			return handleOAuthCallback(request, env)
		}

		if (url.pathname === '/.well-known/appspecific/com.chrome.devtools.json') {
			return new Response(null, { status: 204 })
		}

		if (isProtectedResourceMetadataRequest(url.pathname)) {
			return handleProtectedResourceMetadata(request, env)
		}

		// Trailing-slash variants 404 otherwise; some MCP client docs (and paste
		// habits) include the slash. Keep the protected resource at `/mcp`.
		if (url.pathname === `${mcpResourcePath}/`) {
			const canonical = new URL(request.url)
			canonical.pathname = mcpResourcePath
			return Response.redirect(canonical.toString(), 308)
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

		// Non-production inline package apps. Production requests normally redirect
		// in handlePackageAppOriginRequest; this handler independently returns 500
		// rather than executing package code if that routing invariant is broken.
		if (isPackageAppRequestPath(url.pathname)) {
			return handlePackageAppRequest(request, env)
		}

		if (
			isNamespacedAppEndpointPath(url.pathname) ||
			isNamespacedPackageInvocationEndpointPath(url.pathname)
		) {
			return new Response('Not Found', { status: 404 })
		}

		if (url.pathname.startsWith('/connectors/')) {
			return new Response('Not Found', { status: 404 })
		}

		// Try to serve static assets for safe methods only. Any non-404 status
		// (including 304 Not Modified for conditional requests) must be passed
		// through; treating 304 as a miss would fall through to the app router
		// and return 404 for every browser revalidation request.
		if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
			const response = await env.ASSETS.fetch(request)
			if (response.status !== 404) {
				if (shouldApplyLongLivedAssetCaching(url.pathname, env)) {
					const headers = new Headers(response.headers)
					headers.set('Cache-Control', 'public, max-age=31536000, immutable')
					return new Response(response.body, {
						status: response.status,
						statusText: response.statusText,
						headers,
					})
				}
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
	// Client ID Metadata Documents (MCP 2025-11-25 SEP-991): clients may use
	// an HTTPS URL as their client_id instead of registering via DCR. The
	// 2026-07-28 revision deprecates RFC 7591 DCR in favor of CIMD, so both
	// stay enabled: CIMD clients present their URL client_id with no
	// registration step, and clients that do not use CIMD register via
	// /oauth/register. A failed CIMD metadata fetch returns invalid_client;
	// whether a client then registers via DCR is the client's own recovery.
	// Requires the global_fetch_strictly_public compatibility flag (set in
	// wrangler.jsonc) so metadata fetches are SSRF-safe; the provider only
	// advertises CIMD support when both are on.
	clientIdMetadataDocumentEnabled: true,
	// Provider default onError logs every structured OAuth error via console.warn.
	// Keep those responses on the wire without duplicating them into worker logs /
	// test console guards; unexpected throws still reach our fetch catch + Sentry.
	onError: () => undefined,
	// NOTE: we intentionally do NOT set `allowPlainPKCE: false`. In this provider
	// version that option rejects EVERY authorize request whose
	// `code_challenge_method` is absent or `plain` — including confidential
	// clients that legitimately use no PKCE — which breaks real MCP clients. See
	// the OAuth section of docs/contributing/security.md before changing this.
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

function isOAuthProviderOwnedPath(pathname: string) {
	return (
		pathname === oauthPaths.token ||
		pathname === oauthPaths.register ||
		pathname === oauthPaths.discovery ||
		pathname === protectedResourceMetadataPath ||
		pathname.startsWith(`${protectedResourceMetadataPath}/`) ||
		pathname.startsWith(oauthPaths.apiPrefix)
	)
}

function isMalformedOAuthClientException(error: unknown, pathname: string) {
	const message = error instanceof Error ? error.message : ''
	// @cloudflare/workers-oauth-provider still throws this raw TypeError when a
	// stored client is missing redirectUris during token redirect_uri checks.
	return (
		pathname === oauthPaths.token &&
		message.includes("Cannot read properties of undefined (reading 'some')")
	)
}

function createOAuthProviderExceptionResponse(
	error: unknown,
	pathname: string,
) {
	const headers = {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json',
	}
	if (isMalformedOAuthClientException(error, pathname)) {
		return new Response(
			JSON.stringify({
				error: 'invalid_client',
				error_description: 'Invalid OAuth client registration.',
			}),
			{ status: 401, headers },
		)
	}

	const errorDescription =
		pathname === oauthPaths.register
			? 'Invalid OAuth client registration.'
			: 'OAuth provider request failed.'
	return new Response(
		JSON.stringify({
			error:
				pathname === oauthPaths.register ? 'invalid_request' : 'server_error',
			error_description: errorDescription,
		}),
		{ status: pathname === oauthPaths.register ? 400 : 500, headers },
	)
}

const workerHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url)

		// Host isolation for hosted package apps runs before every other route:
		// nothing first-party may be reachable on the package-app origin, and the
		// app origin must not execute package code once that origin is configured.
		const packageAppOriginResponse = await handlePackageAppOriginRequest(
			request,
			env,
		)
		if (packageAppOriginResponse) return packageAppOriginResponse

		if (isPackageInvocationApiRequest(url.pathname)) {
			return handlePackageInvocationApiRequest(request, env, ctx)
		}
		if (isWebhookIngressRequest(url.pathname)) {
			return handleWebhookIngressRequest(request, env, ctx)
		}

		const connectorResponse = await handleUserScopedConnectorRequest(
			request,
			env,
		)
		if (connectorResponse) return connectorResponse

		if (isNamespacedPackageInvocationEndpointPath(url.pathname)) {
			return new Response('Not Found', { status: 404 })
		}

		// Domain-migration redirect for safe browser navigation from legacy app
		// hosts. Runs after the API-shaped surfaces (package apps, invocation
		// API, webhooks, connectors) so those keep serving on every attached
		// host, and skips MCP/OAuth/auth/health paths itself. No-op unless
		// APP_LEGACY_REDIRECT is enabled.
		const legacyHostRedirect = getLegacyHostRedirectResponse({ request, env })
		if (legacyHostRedirect) return legacyHostRedirect

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
		try {
			return await oauthProvider.fetch(request, env, ctx)
		} catch (error) {
			if (!isOAuthProviderOwnedPath(url.pathname)) throw error
			Sentry.captureException(error)
			return createOAuthProviderExceptionResponse(error, url.pathname)
		}
	},
	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		// Let storage/transient failures throw so Email Routing does not
		// acknowledge the message (retryable). Permanent rejects use
		// message.setReject inside handleInboundEmail.
		await handleInboundEmail(message, env, ctx)
	},
	async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
		await handleQueueBatch(batch, env, ctx)
	},
	async scheduled(
		controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	) {
		await dispatchScheduledLanes({ controller, env })
	},
} satisfies ExportedHandler<Env>

export default Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	workerHandler,
)
