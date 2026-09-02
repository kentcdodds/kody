import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import {
	createAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import {
	twoFactorVerificationType,
	verifyTwoFactorCode,
} from '#app/two-factor.ts'
import {
	destroyVerifySessionCookie,
	readVerifySession,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import {
	checkRateLimit,
	releaseRateLimit,
	twoFactorVerifyRateLimitConfig,
} from '#app/rate-limit.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'

export function createVerifyHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			setVerifySessionSecret(env.COOKIE_SECRET)
			const pendingSession = await readVerifySession(request)
			if (!pendingSession) {
				// Preserve the destination so a re-login still lands the user
				// where they were originally headed.
				const loginUrl = new URL('/login', request.url)
				const redirectTo = normalizeRedirectTo(
					new URL(request.url).searchParams.get('redirectTo'),
				)
				if (redirectTo) loginUrl.searchParams.set('redirectTo', redirectTo)
				return Response.redirect(loginUrl, 302)
			}

			return renderAppPage({
				request,
				env,
				title: 'Two-factor authentication',
			})
		},
	} satisfies Action<typeof routes.verify>
}

const verifyRequestSchema = object({
	code: string(),
})

export function createTwoFactorVerifyApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			setVerifySessionSecret(env.COOKIE_SECRET)
			setAuthSessionSecret(env.COOKIE_SECRET)

			const requestIp = getRequestIp(request) ?? undefined
			const pendingSession = await readVerifySession(request)
			if (!pendingSession) {
				return jsonResponse(
					{
						ok: false,
						code: 'expired',
						error: 'Your verification session expired. Please log in again.',
					},
					401,
				)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(verifyRequestSchema, body)
			const code = parsed.success ? parsed.value.code.trim() : ''
			if (!code) {
				return jsonResponse(
					{ ok: false, error: 'Verification code is required.' },
					400,
				)
			}

			// Per-account budget for code guesses. The pending cookie is a
			// stateless 10-minute credential that can be re-minted by logging in
			// again, so the attempt counter has to live outside it.
			const rateLimitKey = `auth:2fa-verify:${pendingSession.stableUserId}`
			const rateLimit = await checkRateLimit(
				env.APP_DB,
				rateLimitKey,
				twoFactorVerifyRateLimitConfig,
			)
			if (!rateLimit.allowed) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'login_2fa_verify',
					result: 'rate_limited',
					email: pendingSession.email,
					ip: requestIp,
					path: url.pathname,
				})
				return jsonResponse(
					{
						ok: false,
						code: 'locked',
						error:
							'Too many verification attempts. Please log in again in a few minutes.',
					},
					{
						status: 429,
						headers: {
							'Retry-After': String(
								rateLimit.retryAfterSeconds ??
									twoFactorVerifyRateLimitConfig.windowSeconds,
							),
							'Set-Cookie': await destroyVerifySessionCookie(
								isSecureRequest(request),
							),
						},
					},
				)
			}

			const db = createDb(env.APP_DB)
			const userRecord = await db.findOne(usersTable, {
				where: { stable_user_id: pendingSession.stableUserId },
			})
			const codeValid =
				userRecord != null &&
				(await verifyTwoFactorCode({
					db: env.APP_DB,
					userId: userRecord.id,
					code,
					type: twoFactorVerificationType,
				}))
			if (!codeValid) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'login_2fa_verify',
					result: 'failure',
					email: pendingSession.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_code',
				})
				return jsonResponse({ ok: false, error: 'Invalid code.' }, 400)
			}

			// A completed sign-in should not leave the account's remaining
			// attempt budget spent.
			await releaseRateLimit(env.APP_DB, rateLimitKey).catch(() => undefined)

			const secure = isSecureRequest(request)
			const headers = new Headers({
				'Cache-Control': 'no-store',
				'Content-Type': 'application/json; charset=utf-8',
			})
			headers.append(
				'Set-Cookie',
				await createAuthCookie(
					{
						stableUserId: pendingSession.stableUserId,
						email: pendingSession.email,
						rememberMe: pendingSession.rememberMe,
					},
					secure,
				),
			)
			headers.append('Set-Cookie', await destroyVerifySessionCookie(secure))

			await touchLastActiveAt(env.APP_DB, {
				stableUserId: pendingSession.stableUserId,
			})
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'login_2fa_verify',
				result: 'success',
				email: pendingSession.email,
				ip: requestIp,
				path: url.pathname,
			})
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers,
			})
		},
	} satisfies Action<typeof routes.verifyTwoFactorApi>
}
