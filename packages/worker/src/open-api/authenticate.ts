import { readBearerApiToken } from '@kody-internal/shared/api-token-format.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	authenticateApiToken,
	getApiTokenIssuedAtMs,
	slideApiTokenExpiry,
	touchApiToken,
	type ApiTokenAuthenticationFailure,
} from '#worker/api-tokens/service.ts'
import { buildMcpUserContextFromGrantProps } from '#worker/mcp-auth-user-context.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import {
	createApiInvocationContext,
	type ApiInvocationContext,
} from './context.ts'
import { ApiError } from './errors.ts'

function unauthorized(message: string, invalidToken: boolean) {
	return new ApiError({
		status: 401,
		code: 'unauthorized',
		message,
		headers: {
			'WWW-Authenticate': invalidToken
				? `Bearer realm="kody-api", error="invalid_token"`
				: `Bearer realm="kody-api"`,
		},
	})
}

function describeFailure(reason: ApiTokenAuthenticationFailure) {
	switch (reason) {
		case 'malformed':
		case 'unknown':
			return 'Invalid API token.'
		case 'expired':
			return 'API token expired. Mint a new one (MCP api tool: tokenCreate).'
		case 'revoked':
			return 'API token was revoked.'
		default: {
			const exhaustive: never = reason
			throw new Error(`Unexpected API token failure: ${String(exhaustive)}`)
		}
	}
}

/**
 * Authenticate an Open API request by its `kody_at_` bearer token and build
 * the invocation context. Mirrors the `/mcp` account gates: the account must
 * exist and not be deleting, have a verified email, not be suspended, and the
 * token must postdate the last password change. Throws `ApiError` (401/403).
 */
export async function authenticateApiRequest(input: {
	request: Request
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
}): Promise<ApiInvocationContext> {
	const token = readBearerApiToken(input.request.headers.get('Authorization'))
	if (!token) {
		throw unauthorized(
			'Authentication required. Send Authorization: Bearer <Kody API token>.',
			false,
		)
	}
	const now = new Date()
	const authentication = await authenticateApiToken({
		db: input.env.APP_DB,
		token,
		now,
	})
	if (!authentication.ok) {
		throw unauthorized(describeFailure(authentication.reason), true)
	}
	const { record } = authentication
	const authContext = await buildMcpUserContextFromGrantProps(input.env, {
		userId: record.user_id,
	})
	if (!authContext) throw unauthorized('Invalid API token.', true)
	if (!authContext.emailVerified) {
		throw new ApiError({
			status: 403,
			code: 'email_verification_required',
			message: `Your account email address is not verified, so API access is disabled. Verify it from ${input.appOrigin}/account.`,
		})
	}
	if (authContext.suspended) {
		throw new ApiError({
			status: 403,
			code: 'account_suspended',
			message:
				'This account is suspended, so API access is disabled. Contact the operator of this Kody deployment to appeal.',
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
	return createApiInvocationContext({
		env: input.env,
		callerContext: {
			...createMcpCallerContext({
				baseUrl: input.appOrigin,
				executionOrigin: 'interactive',
				user: authContext.user,
			}),
			user: authContext.user,
		},
		principal: { kind: 'token', token: slid ?? record },
		waitUntil: input.waitUntil,
	})
}
