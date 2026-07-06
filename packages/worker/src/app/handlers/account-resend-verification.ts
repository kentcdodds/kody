import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createEmailVerification } from '#app/email-verification.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { type routes } from '#app/routes.ts'
import { type AppEnv } from '#worker/env-schema.ts'

export const resendVerificationRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

export function createAccountResendVerificationHandler(appEnv: AppEnv) {
	const env = appEnv as unknown as Env

	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const requestIp = getRequestIp(request) ?? undefined
			if (user.emailVerified) {
				return jsonResponse(
					{ ok: false, error: 'Your email is already verified.' },
					400,
				)
			}

			const rateLimitKey = `verification-resend:user:${user.userId}`
			const rateLimit = await checkRateLimit(
				appEnv.APP_DB,
				rateLimitKey,
				resendVerificationRateLimitConfig,
			)
			if (!rateLimit.allowed) {
				void logAuditEvent({
					category: 'auth',
					action: 'email_verification_resend',
					result: 'rate_limited',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})
				return jsonResponse(
					{
						ok: false,
						error:
							'Too many verification emails requested. Please try again later.',
					},
					429,
					{ 'Retry-After': String(rateLimit.retryAfterSeconds ?? 60) },
				)
			}

			try {
				await createEmailVerification({
					appEnv,
					userId: user.userId,
					email: user.email,
					requestUrl: url,
				})
			} catch (error) {
				console.error('Failed to resend verification email:', error)
				// A failed send should not eat into the user's resend
				// allowance; refund the slot so they can retry promptly.
				await releaseRateLimit(appEnv.APP_DB, rateLimitKey).catch(
					() => undefined,
				)
				void logAuditEvent({
					category: 'auth',
					action: 'email_verification_resend',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'send_failed',
				})
				return jsonResponse(
					{
						ok: false,
						error:
							'Unable to send the verification email. Please try again later.',
					},
					502,
				)
			}

			void logAuditEvent({
				category: 'auth',
				action: 'email_verification_resend',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
			})
			return jsonResponse({
				ok: true,
				message: 'Verification email sent. Check your inbox.',
			})
		},
	} satisfies Action<typeof routes.accountResendVerification>
}

function jsonResponse(
	body: Record<string, unknown>,
	status = 200,
	extraHeaders: Record<string, string> = {},
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
			...extraHeaders,
		},
	})
}
