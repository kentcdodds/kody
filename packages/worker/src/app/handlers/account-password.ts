import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { object, optional, parseSafe, string } from 'remix/data-schema'
import {
	applyPasswordChange,
	type ApplyPasswordChangeResult,
} from '#app/apply-password-change.ts'
import {
	createAuthCookie,
	isSecureRequest,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { isUsablePasswordHash } from '#worker/identity/usable-password.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import { type routes } from '#universal/routes.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'

const passwordChangeRateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 15 * 60,
}

const passwordChangeRequestSchema = object({
	currentPassword: optional(string()),
	newPassword: string(),
})

function applyFailureReason(
	result: Extract<ApplyPasswordChangeResult, { ok: false }>,
) {
	switch (result.reason) {
		case 'oauth_provider_unavailable':
			return result.reason
		case 'oauth_grant_revoke_failed':
			return result.detail
		default: {
			const unreachable: never = result
			return unreachable
		}
	}
}

function passwordChangeIssuedAt(result: ApplyPasswordChangeResult) {
	if (result.ok) return result.changedAtMs + 1
	if (
		result.reason === 'oauth_grant_revoke_failed' &&
		result.changedAtMs != null
	) {
		return result.changedAtMs + 1
	}
	return Date.now()
}

export function createAccountPasswordHandler(env: Env) {
	const db = createDb(env.APP_DB)

	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse({ ok: false, error: 'Invalid JSON payload.' }, 400)
			}

			const parsed = parseSafe(passwordChangeRequestSchema, body)
			const requestIp = getRequestIp(request) ?? undefined
			const currentPassword = parsed.success
				? (parsed.value.currentPassword ?? '')
				: ''
			const newPassword = parsed.success ? parsed.value.newPassword : ''

			if (!parsed.success || !newPassword) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_change',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_payload',
				})
				return jsonResponse(
					{ ok: false, error: 'New password is required.' },
					400,
				)
			}

			const passwordError = getPasswordPolicyError(newPassword)
			if (passwordError) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_change',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'weak_password',
				})
				return jsonResponse({ ok: false, error: passwordError }, 400)
			}

			const userRecord = await db.findOne(usersTable, {
				where: { id: user.userId },
			})
			if (!userRecord) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const rateLimitKey = `password-change:user:${user.userId}`
			const rateLimit = await checkRateLimit(
				env.APP_DB,
				rateLimitKey,
				passwordChangeRateLimitConfig,
			)
			if (!rateLimit.allowed) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_change',
					result: 'rate_limited',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})
				return jsonResponse(
					{
						ok: false,
						error: 'Too many password change attempts. Please try again later.',
					},
					{
						status: 429,
						headers: {
							'Retry-After': String(rateLimit.retryAfterSeconds ?? 60),
						},
					},
				)
			}

			const hasUsablePassword = isUsablePasswordHash(userRecord.password_hash)
			if (hasUsablePassword) {
				if (!currentPassword) {
					void logAuditEvent({
						category: 'auth',
						action: 'password_change',
						result: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'missing_current_password',
					})
					return jsonResponse(
						{ ok: false, error: 'Current password is required.' },
						400,
					)
				}
				const passwordValid = await verifyPassword(
					currentPassword,
					userRecord.password_hash,
				)
				if (!passwordValid) {
					void logAuditEvent({
						category: 'auth',
						action: 'password_change',
						result: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'invalid_password',
					})
					return jsonResponse(
						{
							ok: false,
							code: 'invalid_password',
							error: 'Current password is incorrect.',
						},
						401,
					)
				}
				if (currentPassword === newPassword) {
					void logAuditEvent({
						category: 'auth',
						action: 'password_change',
						result: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'same_password',
					})
					return jsonResponse(
						{ ok: false, error: 'Choose a different password.' },
						400,
					)
				}
			}

			const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthGrantHelpers })
				.OAUTH_PROVIDER
			const result = await applyPasswordChange({
				db,
				helpers,
				userId: user.userId,
				stableUserId: resolveUserStableId(userRecord),
				password: newPassword,
			})

			const sessionUserId = user.sessionUserId
			const sessionEmail = user.email
			async function sessionCookieForChange() {
				const parsedSession = await readParsedAuthSession(request)
				return createAuthCookie(
					{
						stableUserId: sessionUserId,
						email: sessionEmail,
						rememberMe: parsedSession?.session.rememberMe ?? false,
					},
					isSecureRequest(request),
					passwordChangeIssuedAt(result),
				)
			}

			if (!result.ok) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_change',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: applyFailureReason(result),
				})
				if (!result.stamped) {
					return jsonResponse(
						{
							ok: false,
							error: 'Unable to update your password right now.',
						},
						500,
					)
				}
				return jsonResponse(
					{
						ok: false,
						error: 'Unable to update your password right now.',
					},
					{
						status: 500,
						headers: { 'Set-Cookie': await sessionCookieForChange() },
					},
				)
			}

			void logAuditEvent({
				category: 'auth',
				action: 'password_change',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
			})
			return jsonResponse(
				{
					ok: true,
					message: hasUsablePassword
						? 'Password updated. Other sessions and connected MCP hosts need to sign in again.'
						: 'Password saved. You can sign in with email and password, and other sessions and connected MCP hosts need to sign in again.',
				},
				{ headers: { 'Set-Cookie': await sessionCookieForChange() } },
			)
		},
	} satisfies Action<typeof routes.accountPassword>
}
