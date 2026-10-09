import {
	parseApiToken,
	readBearerApiToken,
} from '@kody-internal/shared/api-token-format.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	authenticateApiToken,
	getApiTokenIssuedAtMs,
	slideApiTokenExpiry,
	touchApiToken,
	type ApiTokenAuthenticationFailure,
} from '#worker/api-tokens/service.ts'
import { loadOrgBindingFromGrantProps } from '#worker/orgs/grant-binding.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { cliClientIdMetadataPath } from '#worker/cli-client-metadata.ts'
import { buildMcpUserContextFromGrantProps } from '#worker/mcp-auth-user-context.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import {
	createApiInvocationContext,
	type ApiInvocationContext,
} from './context.ts'
import { ApiError } from './errors.ts'
import { readConnectionProfileNameFromGrantProps } from '#worker/connection-profiles/oauth.ts'

type McpOauthGrantProps = {
	userId?: unknown
	email?: unknown
	username?: unknown
	displayName?: unknown
	authTime?: unknown
	nonce?: unknown
}

type McpOauthTokenSummary = {
	createdAt: number
	expiresAt: number
	audience?: string | Array<string>
	scope?: Array<string>
	grant: {
		clientId: string
		scope: Array<string>
		props: McpOauthGrantProps
	}
}

type McpOauthHelpers = {
	unwrapToken: (token: string) => Promise<McpOauthTokenSummary | null>
}

function unauthorized(
	message: string,
	invalidToken: boolean,
	meteringUserId?: string,
) {
	return new ApiError({
		status: 401,
		code: 'unauthorized',
		message,
		headers: {
			'WWW-Authenticate': invalidToken
				? `Bearer realm="kody-api", error="invalid_token"`
				: `Bearer realm="kody-api"`,
		},
		meteringUserId,
	})
}

function describeFailure(reason: ApiTokenAuthenticationFailure) {
	switch (reason) {
		case 'malformed':
		case 'unknown':
			return 'Invalid API token.'
		case 'expired':
			return 'API token expired. Agents on MCP: call cliCredentialBootstrap with lifetime short|long, then `npx @kodycodes/cli auth bootstrap --code …`. CI/headless: mint with tokenCreate.'
		case 'revoked':
			return 'API token was revoked.'
		default: {
			const exhaustive: never = reason
			throw new Error(`Unexpected API token failure: ${String(exhaustive)}`)
		}
	}
}

/**
 * MCP OAuth access tokens are audience-bound to the app origin `/mcp` resource
 * (same check as `mcp-auth.ts`). Local-execute HTTP may accept that class only
 * on CapabilityProxy / package-graph — not as a general Open API bearer.
 */
function mcpOauthAudienceMatches(
	audience: string | Array<string> | undefined,
	appOrigin: string,
) {
	if (!audience) return false
	const allowed = Array.isArray(audience) ? audience : [audience]
	const resourcePath = `${appOrigin}/mcp`
	return allowed.some((value) => value === appOrigin || value === resourcePath)
}

async function authenticateWithApiToken(input: {
	token: string
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
}): Promise<ApiInvocationContext> {
	const now = new Date()
	const authentication = await authenticateApiToken({
		db: input.env.APP_DB,
		token: input.token,
		now,
	})
	if (!authentication.ok) {
		throw unauthorized(
			describeFailure(authentication.reason),
			true,
			authentication.record?.user_id,
		)
	}
	const { record } = authentication
	const authContext = await buildMcpUserContextFromGrantProps(input.env, {
		userId: record.user_id,
	})
	if (!authContext)
		throw unauthorized('Invalid API token.', true, record.user_id)
	if (!authContext.emailVerified) {
		throw new ApiError({
			status: 403,
			code: 'email_verification_required',
			message: `Your account email address is not verified, so API access is disabled. Verify it from ${input.appOrigin}/account.`,
			meteringUserId: authContext.user.userId,
		})
	}
	if (authContext.suspended) {
		throw new ApiError({
			status: 403,
			code: 'account_suspended',
			message:
				'This account is suspended, so API access is disabled. Contact the operator of this Kody deployment to appeal.',
			meteringUserId: authContext.user.userId,
		})
	}
	if (
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: getApiTokenIssuedAtMs(record),
			storedPasswordChangedAt: authContext.passwordChangedAt,
		})
	) {
		throw unauthorized(
			'API token predates a password change. Mint a new one.',
			true,
			authContext.user.userId,
		)
	}
	const slid = slideApiTokenExpiry(record, now)
	if (slid) {
		input.waitUntil(
			touchApiToken({ db: input.env.APP_DB, record: slid }).catch(
				(error: unknown) => {
					console.warn('api-token-touch-failed', record.id, error)
				},
			),
		)
	}
	const orgId = record.org_id.trim() || record.user_id
	const orgBinding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		authContext.user.userId,
		orgId,
	)
	if (!orgBinding) {
		throw unauthorized(
			'API token is not bound to an org you can access.',
			true,
			authContext.user.userId,
		)
	}
	return createApiInvocationContext({
		env: input.env,
		callerContext: {
			...createMcpCallerContext({
				baseUrl: input.appOrigin,
				source: { kind: 'api-token', tokenId: record.id },
				executionOrigin: 'interactive',
				user: authContext.user,
				connectionProfileName: record.profile_name ?? null,
				orgBinding,
				scopes: record.scopes,
			}),
			user: authContext.user,
		},
		principal: { kind: 'token', token: slid ?? record },
		waitUntil: input.waitUntil,
	})
}

async function authenticateWithMcpOauth(input: {
	token: string
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
}): Promise<ApiInvocationContext> {
	const helpers = await resolveOAuthHelpers<McpOauthHelpers>(input.env)
	const tokenSummary = helpers ? await helpers.unwrapToken(input.token) : null
	const expectedCliClientId = `${new URL(input.appOrigin).origin}${cliClientIdMetadataPath}`
	if (
		!tokenSummary ||
		!mcpOauthAudienceMatches(tokenSummary.audience, input.appOrigin) ||
		tokenSummary.grant.clientId !== expectedCliClientId
	) {
		throw unauthorized('Invalid API token.', true)
	}
	const authContext = await buildMcpUserContextFromGrantProps(
		input.env,
		tokenSummary.grant.props,
	)
	if (!authContext) {
		throw unauthorized('Invalid API token.', true)
	}
	if (!authContext.emailVerified) {
		throw new ApiError({
			status: 403,
			code: 'email_verification_required',
			message: `Your account email address is not verified, so API access is disabled. Verify it from ${input.appOrigin}/account.`,
			meteringUserId: authContext.user.userId,
		})
	}
	if (authContext.suspended) {
		throw new ApiError({
			status: 403,
			code: 'account_suspended',
			message:
				'This account is suspended, so API access is disabled. Contact the operator of this Kody deployment to appeal.',
			meteringUserId: authContext.user.userId,
		})
	}
	if (
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: tokenSummary.createdAt * 1000,
			storedPasswordChangedAt: authContext.passwordChangedAt,
		})
	) {
		throw unauthorized(
			'Access token predates a password change. Run kody login again.',
			true,
			authContext.user.userId,
		)
	}
	const grantScopes =
		tokenSummary.scope ??
		(Array.isArray(tokenSummary.grant.scope) ? tokenSummary.grant.scope : [])
	const orgBinding = await loadOrgBindingFromGrantProps({
		db: input.env.APP_DB,
		personId: authContext.user.userId,
		grantProps: tokenSummary.grant.props,
	})
	if (!orgBinding) {
		throw unauthorized(
			'Access token is not bound to an org you can access.',
			true,
			authContext.user.userId,
		)
	}
	return createApiInvocationContext({
		env: input.env,
		callerContext: {
			...createMcpCallerContext({
				baseUrl: input.appOrigin,
				source: { kind: 'cli' },
				executionOrigin: 'interactive',
				user: authContext.user,
				connectionProfileName: readConnectionProfileNameFromGrantProps(
					tokenSummary.grant.props,
				),
				orgBinding,
			}),
			user: authContext.user,
		},
		principal: {
			kind: 'mcp-oauth',
			expiresAtUnix: tokenSummary.expiresAt,
			grantScopes,
		},
		waitUntil: input.waitUntil,
	})
}

/**
 * Authenticate an Open API request and build the invocation context.
 *
 * Default path: scoped `kody_at_` API tokens (scopes + idle TTL). When
 * `allowMcpOauth` is true (local-execute HTTP surfaces only), a valid MCP /
 * CLI OAuth access token for this app origin is accepted with the full MCP
 * grant — no API-token scope checks. Account gates match `/mcp`: verified
 * email, not suspended, not deleting, and the credential must postdate the
 * last password change. Throws `ApiError` (401/403).
 */
export async function authenticateApiRequest(input: {
	request: Request
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
	/**
	 * When true, accept a valid MCP OAuth access token (CLI `kody login`) for
	 * CapabilityProxy / package-graph. Keep false for every other Open API
	 * route so OAuth stays out of the general credential class (ADR 0053/0055).
	 */
	allowMcpOauth?: boolean
}): Promise<ApiInvocationContext> {
	const token = readBearerApiToken(input.request.headers.get('Authorization'))
	if (!token) {
		throw unauthorized(
			'Authentication required. Send Authorization: Bearer <Kody API token>.',
			false,
		)
	}
	if (parseApiToken(token)) {
		return authenticateWithApiToken({
			token,
			env: input.env,
			appOrigin: input.appOrigin,
			waitUntil: input.waitUntil,
		})
	}
	if (input.allowMcpOauth) {
		return authenticateWithMcpOauth({
			token,
			env: input.env,
			appOrigin: input.appOrigin,
			waitUntil: input.waitUntil,
		})
	}
	throw unauthorized('Invalid API token.', true)
}
