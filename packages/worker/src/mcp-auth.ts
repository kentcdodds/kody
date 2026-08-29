import {
	type OAuthHelpers,
	type TokenSummary,
} from '@cloudflare/workers-oauth-provider'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { auditDatabaseFromEnv, getRequestIp } from '#worker/audit-log.ts'
import { buildMcpUserContextFromGrantProps } from './mcp-auth-user-context.ts'
import {
	type McpAuthDenialReason,
	recordMcpAuthDenial,
} from './mcp/auth-audit.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { createMcpCallerContext, type McpServerProps } from './mcp/context.ts'
import {
	classifyMcpProtocolRequest,
	recordMcpProtocolEvent,
} from './mcp/protocol-metrics.ts'
import { handleStatelessMcpRequest } from './mcp/stateless-lane.ts'
import { oauthScopes } from './oauth-handlers.ts'
import { stampFirstMcpConnected } from '#worker/identity/activation-stamps.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'

export const mcpResourcePath = '/mcp'
export const protectedResourceMetadataPath =
	'/.well-known/oauth-protected-resource'

type OAuthEnv = Env & {
	OAUTH_PROVIDER?: OAuthHelpers
}

type OAuthContextProps = McpServerProps & {
	user?: TokenSummary['grant']['props'] | null
}

type OAuthExecutionContext = ExecutionContext & {
	props?: OAuthContextProps
}

export function buildProtectedResourceMetadata(origin: string) {
	return {
		resource: `${origin}${mcpResourcePath}`,
		authorization_servers: [origin],
		scopes_supported: oauthScopes,
		// Match @cloudflare/workers-oauth-provider's path-based metadata document.
		// Browser MCP clients (Gemini custom apps, etc.) fetch the root PRM from
		// WWW-Authenticate; omitting this field leaves header-bearer support
		// ambiguous and has broken Gemini's pre-DCR handshake in production.
		bearer_methods_supported: ['header'],
	}
}

export function isProtectedResourceMetadataRequest(pathname: string) {
	return (
		pathname === protectedResourceMetadataPath ||
		pathname === `${protectedResourceMetadataPath}${mcpResourcePath}`
	)
}

export function handleProtectedResourceMetadata(request: Request, env?: Env) {
	const origin = getAppBaseUrl({
		env: env ?? {},
		requestUrl: request.url,
	})
	return new Response(JSON.stringify(buildProtectedResourceMetadata(origin)), {
		headers: { 'Content-Type': 'application/json' },
	})
}

export const mcpInvalidTokenDescription =
	'Authentication required. Obtain an access token via OAuth and retry with Authorization: Bearer.'

type McpUnauthorizedKind = 'missing_credential' | 'invalid_token'

function buildWwwAuthenticateHeader(origin: string, kind: McpUnauthorizedKind) {
	const resourceMetadata = `${origin}${protectedResourceMetadataPath}`
	const scope =
		oauthScopes.length > 0 ? `, scope="${oauthScopes.join(' ')}"` : ''
	const resourceAndScope = `resource_metadata="${resourceMetadata}"${scope}`
	switch (kind) {
		case 'missing_credential':
			// RFC 6750 §3.1: omit error attributes when no credentials were sent.
			return `Bearer ${resourceAndScope}`
		case 'invalid_token':
			// Hosts that refresh on `error="invalid_token"` need that attribute on
			// the wire, not only in the JSON body.
			return `Bearer error="invalid_token", error_description="${mcpInvalidTokenDescription}", ${resourceAndScope}`
		default: {
			const exhaustive: never = kind
			throw new Error(`unexpected MCP unauthorized kind: ${exhaustive}`)
		}
	}
}

function createUnauthorizedBody(kind: McpUnauthorizedKind) {
	switch (kind) {
		case 'missing_credential':
			return { error_description: mcpInvalidTokenDescription }
		case 'invalid_token':
			return {
				error: 'invalid_token',
				error_description: mcpInvalidTokenDescription,
			}
		default: {
			const exhaustive: never = kind
			throw new Error(`unexpected MCP unauthorized kind: ${exhaustive}`)
		}
	}
}

function readBearerToken(authorization: string | null) {
	if (!authorization) return null
	const match = authorization.match(/^Bearer(?:\s+(.*))?$/i)
	if (!match) return null
	const token = match[1]?.trim() ?? ''
	return token.length > 0 ? token : null
}

function createUnauthorizedResponse(origin: string, kind: McpUnauthorizedKind) {
	// Keep a JSON body in addition to WWW-Authenticate. Some remote MCP clients
	// (notably Gemini custom connected apps) treat an empty 401 as a hard
	// connectivity failure and never start OAuth discovery / DCR.
	return Response.json(createUnauthorizedBody(kind), {
		status: 401,
		headers: {
			'WWW-Authenticate': buildWwwAuthenticateHeader(origin, kind),
		},
	})
}

function acceptsMediaType(accept: string, mediaType: string) {
	return accept.split(',').some((range) => {
		const [type, ...parameters] = range.trim().split(';')
		if (type?.trim() !== mediaType) return false
		const quality = parameters
			.map((parameter) => parameter.trim())
			.find((parameter) => parameter.startsWith('q='))
		return quality ? Number(quality.slice(2)) > 0 : true
	})
}

function isBrowserMcpNavigation(request: Request) {
	if (request.method !== 'GET' || request.headers.has('Authorization')) {
		return false
	}
	const accept = request.headers.get('Accept')?.toLowerCase()
	if (!accept) return false
	return (
		acceptsMediaType(accept, 'text/html') &&
		!accept.includes('text/event-stream') &&
		!accept.includes('application/json')
	)
}

function createMcpBrowserLandingResponse(request: Request) {
	const onboardingUrl = new URL('/onboarding', request.url).toString()
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kody MCP endpoint</title></head><body><main style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><p style="font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#57606a">Kody secure connection</p><h1>This endpoint is for AI agents</h1><p>You’ve reached Kody’s MCP endpoint. AI agents use this address to connect to Kody, so there isn’t anything to browse here.</p><p><a href="${onboardingUrl}">Follow the guide to connect your agent</a></p></main></body></html>`,
		{
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/html; charset=utf-8',
			},
		},
	)
}

export function createEmailVerificationRequiredResponse(origin: string) {
	return Response.json(
		{
			error: 'email_verification_required',
			error_description:
				'Your account email address is not verified, so MCP access is disabled. ' +
				`Open the verification link sent to your email, or resend it from ${origin}/account.`,
		},
		{ status: 403 },
	)
}

export function createAccountSuspendedResponse() {
	return Response.json(
		{
			error: 'account_suspended',
			error_description:
				'This account is suspended, so MCP access is disabled. ' +
				'Contact the operator of this Kody deployment to appeal.',
		},
		{ status: 403 },
	)
}

function audienceMatches(
	audience: string | Array<string> | undefined,
	origin: string,
) {
	if (!audience) return false
	const allowed = Array.isArray(audience) ? audience : [audience]
	const resourcePath = `${origin}${mcpResourcePath}`
	return allowed.some((value) => value === origin || value === resourcePath)
}

export async function handleMcpRequest({
	request,
	env,
	ctx,
	fetchMcp,
}: {
	request: Request
	env: Env
	ctx: ExecutionContext
	fetchMcp: CustomExportedHandler<OAuthContextProps>['fetch']
}) {
	const url = new URL(request.url)
	const origin = getAppBaseUrl({
		env,
		requestUrl: url,
	})
	const recordRejection = async (
		reason: McpAuthDenialReason,
		email?: string,
	) => {
		await recordMcpAuthDenial({
			db: auditDatabaseFromEnv(env),
			action: 'mcp_token_rejected',
			reason,
			email,
			ip: getRequestIp(request),
			path: url.pathname,
		})
	}

	if (isBrowserMcpNavigation(request)) {
		return createMcpBrowserLandingResponse(request)
	}

	// Rejections before a grant resolves are deliberately not audited. They are
	// reachable by any anonymous request, so writing a row per attempt would let
	// a stranger drive unbounded D1 writes, and an unattributable "someone sent
	// a bad token" carries little signal on its own. Flood control for anonymous
	// traffic belongs at the edge; see docs/contributing/security.md.
	const token = readBearerToken(request.headers.get('Authorization'))
	if (token === null) {
		return createUnauthorizedResponse(origin, 'missing_credential')
	}

	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		return createUnauthorizedResponse(origin, 'invalid_token')
	}

	const tokenSummary = await helpers.unwrapToken(token)
	if (!tokenSummary || !audienceMatches(tokenSummary.audience, origin)) {
		return createUnauthorizedResponse(origin, 'invalid_token')
	}

	const context = ctx as OAuthExecutionContext
	const grantProps = tokenSummary.grant.props ?? null
	const authContext = await buildMcpUserContextFromGrantProps(env, grantProps)

	// Fail-closed email verification gate: every MCP request must map to an
	// account whose email is verified. Tokens without an identifiable user
	// are rejected too, since verification cannot be established for them. The
	// context loader reads identity, verification, and suspension in one query.
	if (!authContext) {
		await recordRejection('unidentified_grant')
		return createEmailVerificationRequiredResponse(origin)
	}
	const { user: mcpUser } = authContext
	if (!authContext.emailVerified) {
		await recordRejection('email_unverified', mcpUser.email)
		return createEmailVerificationRequiredResponse(origin)
	}

	// Fail-closed suspension gate, mirroring email verification: a
	// suspended account keeps its OAuth grants (stateless tokens cannot be
	// revoked individually) but every MCP request is rejected until an
	// admin clears the suspension.
	if (authContext.suspended) {
		await recordRejection('account_suspended', mcpUser.email)
		return createAccountSuspendedResponse()
	}

	// Password reset stamps password_changed_at and revokes grants. Already-
	// issued access tokens can still unwrap for up to an hour, so reject them
	// the same way browser cookies die — hosts then refresh, the revoked grant
	// fails, and they start a new OAuth flow.
	if (
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: tokenSummary.createdAt * 1000,
			storedPasswordChangedAt: authContext.passwordChangedAt,
		})
	) {
		await recordRejection('password_changed', mcpUser.email)
		return createUnauthorizedResponse(origin, 'invalid_token')
	}

	const props: OAuthContextProps = createMcpCallerContext({
		baseUrl: origin,
		executionOrigin: 'interactive',
		user: mcpUser,
	})
	context.props = props

	// Lane classification: 2025-era ("legacy") requests keep the sessionful
	// Durable Object McpAgent lane; 2026-07-28 envelope requests are served
	// by the stateless SDK v2 lane. Every authenticated request records a
	// lane data point so legacy-lane retirement is a metrics decision — see
	// ./mcp/protocol-metrics.ts for the readout query.
	const classification = await classifyMcpProtocolRequest(request)
	recordMcpProtocolEvent(env, {
		lane: classification.lane,
		method: classification.method,
		protocolVersion: classification.protocolVersion,
		clientName: classification.clientName,
		clientVersion: classification.clientVersion,
		userId: mcpUser.userId,
		requestHost: (() => {
			try {
				return new URL(request.url).hostname
			} catch {
				return ''
			}
		})(),
	})
	ctx.waitUntil(
		(async () => {
			const before = await env.APP_DB.prepare(
				`SELECT first_mcp_connected_at FROM users WHERE stable_user_id = ?`,
			)
				.bind(mcpUser.userId)
				.first<{ first_mcp_connected_at: string | null }>()
			await stampFirstMcpConnected(env.APP_DB, {
				stableUserId: mcpUser.userId,
				clientName: classification.clientName || null,
			})
			if (!before?.first_mcp_connected_at) {
				scheduleKitSubscriberSync({
					env,
					stableUserId: mcpUser.userId,
					email: mcpUser.email,
				})
			}
		})().catch((error) => {
			console.warn('mcp-first-connected-kit-sync-failed', error)
		}),
	)

	return await withAccountWriteLease({
		db: env.APP_DB,
		stableUserId: mcpUser.userId,
		holder: `mcp:${request.method} ${url.pathname}`,
		env,
		write: async () =>
			classification.lane === 'legacy'
				? await fetchMcp(
						request,
						env,
						context as ExecutionContext<OAuthContextProps>,
					)
				: await handleStatelessMcpRequest({
						request,
						env,
						ctx,
						callerContext: props,
						...(classification.parsedBody === undefined
							? {}
							: { parsedBody: classification.parsedBody }),
					}),
	})
}
