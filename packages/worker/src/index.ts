import * as Sentry from '@sentry/cloudflare'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { RemoteConnectorSession } from './remote-connector/session.ts'
import { McpClientHub } from './mcp-client/hub.ts'
import { MCP } from './mcp/index.ts'
import { JobManager } from './jobs/manager-do.ts'
import { StorageRunner } from './storage-runner.ts'
import { RepoSession } from './repo/repo-session-do.ts'
import { PackageRealtimeSession } from '#worker/package-runtime/realtime-session.ts'
import { PackageServiceInstance } from '#worker/package-runtime/package-service.ts'
import { DynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { isRetryableD1LockError } from './d1-retry.ts'
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
import { checkRateLimit, authRateLimitConfig } from '#app/rate-limit.ts'
import { getRequestIp } from '#app/audit-log.ts'
import { handleCapabilityReindexRequest } from './capability-maintenance.ts'
import { handleExecuteSmokeRequest } from './execute-maintenance.ts'
import { handleJobReindexRequest } from './job-maintenance.ts'
import { handleMemoryReindexRequest } from './memory-maintenance.ts'
import { handlePackagePrivacyBackfillRequest } from './maintenance-handler.ts'
import {
	handleMcpAgentSessionBackfillCompleteRequest,
	handleMcpAgentSessionBackfillRequest,
} from './mcp-session-maintenance.ts'
import { reconcileArtifactsPushes } from './jobs/reconcile-artifacts-pushes.ts'
import { cleanupRepoSessionBranches } from './repo/repo-session-cleanup.ts'
import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import {
	parseUserScopedConnectorRoutePath,
	userScopedConnectorSessionKey,
} from './remote-connector/connector-session-key.ts'
import {
	handlePackageAppRequest,
	isPackageAppRequestPath,
} from '#app/handlers/package-app.ts'
import { PackageAppRuntimeBridge } from '#worker/package-runtime/package-app.ts'
import { handleInboundEmail } from '#worker/email/inbound.ts'
import { sweepStaleInboundDeliveries } from '#worker/email/reconcile-inbound-deliveries.ts'
import { pruneSystemEmailRetention } from '#worker/email/system-email.ts'
import { refreshStaleStripePlans } from '#worker/billing/subscription-sync.ts'
import { handleQueueBatch } from '#worker/queue-handler.ts'
import { findPublicUserIdentityByUsername } from '#app/user-lookup.ts'
import { pruneRetention, shouldRunRetentionCron } from '#app/retention.ts'
import {
	checkAuthDenialBurstAndNotify,
	shouldRunAuthDenialAlertCron,
} from '#app/auth-denial-alerts.ts'
import {
	aggregateUsageRollups,
	shouldRunUsageAggregationCron,
} from '#worker/usage/aggregate-rollups.ts'
import {
	isDrExportConfigured,
	runDrExportTick,
	shouldRunDrExportCron,
} from '#worker/dr/exporter.ts'
import { handleDrRestoreRequest } from '#worker/dr/dr-restore.ts'
import { OAuthPurgeCoordinator } from './oauth-purge.ts'

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

function isNamespacedPackageInvocationEndpointPath(pathname: string) {
	const parts = pathname.split('/').filter(Boolean)
	return (
		parts[0]?.startsWith('@') === true &&
		parts[1] === 'api' &&
		parts[2] === 'package-invocations'
	)
}

function isNamespacedAppEndpointPath(pathname: string) {
	const parts = pathname.split('/').filter(Boolean)
	return (
		parts[0]?.startsWith('@') === true &&
		(parts[1] === 'packages' ||
			parts[1] === 'connectors' ||
			parts[1] === 'webhooks')
	)
}

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
	getCorsHeaders(request) {
		const url = new URL(request.url)
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

		if (request.method === 'POST' && rateLimitedAuthPaths.has(url.pathname)) {
			const ip = getRequestIp(request) ?? 'unknown'
			const rateLimitKey = `auth:ip:${ip}`
			const result = await checkRateLimit(
				env.APP_DB,
				rateLimitKey,
				authRateLimitConfig,
			)
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

		if (url.pathname === '/__maintenance/backfill-package-privacy') {
			return handlePackagePrivacyBackfillRequest(request, env)
		}
		if (url.pathname === '/__maintenance/dr-restore') {
			return handleDrRestoreRequest(request, env)
		}
		if (url.pathname === '/__maintenance/backfill-mcp-agent-sessions') {
			return handleMcpAgentSessionBackfillRequest(request, env)
		}
		if (
			url.pathname === '/__maintenance/backfill-mcp-agent-sessions/complete'
		) {
			return handleMcpAgentSessionBackfillCompleteRequest(request, env)
		}

		if (url.pathname.startsWith('/__maintenance/')) {
			return Response.json(
				{ error: 'Unknown maintenance endpoint.' },
				{ status: 404 },
			)
		}

		if (url.pathname === oauthPaths.authorize) {
			try {
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
		const baseUrl = env.APP_BASE_URL ?? 'https://kody.local'
		const scheduledAt = new Date(controller.scheduledTime)
		const lanes: Array<{ name: string; run: () => Promise<unknown> }> = [
			{
				name: 'reconcile_artifacts_pushes',
				run: () => reconcileArtifactsPushes({ env, baseUrl, now: scheduledAt }),
			},
			{
				name: 'repo_session_cleanup',
				run: () => cleanupRepoSessionBranches({ env, now: scheduledAt }),
			},
			{
				name: 'reconcile_inbound_deliveries',
				run: () =>
					sweepStaleInboundDeliveries({
						env,
						now: scheduledAt,
					}),
			},
			{
				name: 'system_email_retention',
				run: () =>
					pruneSystemEmailRetention({
						db: env.APP_DB,
						blobs: env.EMAIL_BLOBS,
						now: scheduledAt,
					}),
			},
			{
				name: 'stripe_plan_refresh',
				run: () => refreshStaleStripePlans({ env, now: scheduledAt }),
			},
			{
				// One global DO serializes invocations and persists independent phase
				// cursors so neither healthy pages nor overlapping crons lose progress.
				name: 'oauth_purge_expired',
				run: () => {
					const id = env.OAUTH_PURGE_COORDINATOR.idFromName('global')
					return env.OAUTH_PURGE_COORDINATOR.get(id).run({
						scheduledAt: scheduledAt.getTime(),
					})
				},
			},
		]
		if (shouldRunRetentionCron(scheduledAt)) {
			lanes.push({
				name: 'retention',
				run: () => pruneRetention({ env, now: scheduledAt }),
			})
		}
		if (shouldRunUsageAggregationCron(scheduledAt)) {
			lanes.push({
				name: 'usage_aggregation',
				run: () => aggregateUsageRollups(env, scheduledAt),
			})
		}
		if (shouldRunAuthDenialAlertCron(scheduledAt)) {
			lanes.push({
				name: 'auth_denial_alert',
				run: () => checkAuthDenialBurstAndNotify({ env, now: scheduledAt }),
			})
		}
		if (shouldRunDrExportCron(scheduledAt) && isDrExportConfigured(env)) {
			lanes.push({
				name: 'dr_export',
				run: () => runDrExportTick({ env, now: scheduledAt }),
			})
		}
		// Lane failures are isolated: each rejection is logged and reported to
		// Sentry explicitly (the withSentry wrapper flushes captured events via
		// waitUntil), but the handler never throws, so one broken lane cannot
		// fail the cron invocation or hide sibling lane failures. Lanes run
		// sequentially so D1 write-heavy crons (retention, reconcile, usage
		// aggregation) do not contend for the same SQLite lock.
		for (const lane of lanes) {
			try {
				await lane.run()
			} catch (error) {
				if (isRetryableD1LockError(error)) {
					console.warn(
						`scheduled_lane_d1_lock_contention lane=${lane.name}`,
						error,
					)
					continue
				}
				console.error(`scheduled_lane_failed lane=${lane.name}`, error)
				Sentry.withScope((scope) => {
					scope.setTag('scheduled.lane', lane.name)
					scope.setContext('scheduled', {
						lane: lane.name,
						scheduledTime: scheduledAt.toISOString(),
						cron: controller.cron,
					})
					Sentry.captureException(error)
				})
			}
		}
	},
} satisfies ExportedHandler<Env>

export default Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	workerHandler,
)
