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
import { oauthScopes } from './oauth-handlers.ts'

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

function buildWwwAuthenticateHeader(origin: string) {
	const resourceMetadata = `${origin}${protectedResourceMetadataPath}`
	const scope =
		oauthScopes.length > 0 ? ` scope="${oauthScopes.join(' ')}"` : ''
	return `Bearer resource_metadata="${resourceMetadata}"${scope}`
}

function createUnauthorizedResponse(origin: string) {
	// Keep a JSON body in addition to WWW-Authenticate. Some remote MCP clients
	// (notably Gemini custom connected apps) treat an empty 401 as a hard
	// connectivity failure and never start OAuth discovery / DCR.
	return Response.json(
		{
			error: 'invalid_token',
			error_description:
				'Authentication required. Obtain an access token via OAuth and retry with Authorization: Bearer.',
		},
		{
			status: 401,
			headers: {
				'WWW-Authenticate': buildWwwAuthenticateHeader(origin),
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
			db: env.APP_DB,
			auditDb: auditDatabaseFromEnv(env),
			action: 'mcp_token_rejected',
			reason,
			email,
			ip: getRequestIp(request),
			path: url.pathname,
		})
	}

	// Rejections before a grant resolves are deliberately not audited. They are
	// reachable by any anonymous request, so writing a row per attempt would let
	// a stranger drive unbounded D1 writes, and an unattributable "someone sent
	// a bad token" carries little signal on its own. Flood control for anonymous
	// traffic belongs at the edge; see docs/contributing/security.md.
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return createUnauthorizedResponse(origin)
	}

	const token = authHeader.slice('Bearer '.length).trim()
	if (!token) {
		return createUnauthorizedResponse(origin)
	}

	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		return createUnauthorizedResponse(origin)
	}

	const tokenSummary = await helpers.unwrapToken(token)
	if (!tokenSummary || !audienceMatches(tokenSummary.audience, origin)) {
		return createUnauthorizedResponse(origin)
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
	const { user: mcpUser, remoteConnectors } = authContext
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

	const props: OAuthContextProps = createMcpCallerContext({
		baseUrl: origin,
		executionOrigin: 'interactive',
		user: mcpUser,
		remoteConnectors: [...remoteConnectors],
	})
	context.props = props

	return await withAccountWriteLease({
		db: env.APP_DB,
		stableUserId: mcpUser.userId,
		holder: `mcp:${request.method} ${url.pathname}`,
		env,
		waitUntil: ctx.waitUntil.bind(ctx),
		write: async () =>
			await fetchMcp(
				request,
				env,
				context as ExecutionContext<OAuthContextProps>,
			),
	})
}
