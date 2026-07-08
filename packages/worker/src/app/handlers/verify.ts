import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import {
	createAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import {
	twoFactorVerificationType,
	verifyTwoFactorCode,
} from '#app/two-factor.ts'
import {
	destroyVerifySessionCookie,
	readVerifySession,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { type AppEnv } from '#worker/env-schema.ts'

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
				const redirectTo = new URL(request.url).searchParams.get('redirectTo')
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

export function createTwoFactorVerifyApiHandler(appEnv: AppEnv) {
	return {
		middleware: [],
		async handler({ request, url }) {
			setVerifySessionSecret(appEnv.COOKIE_SECRET)
			setAuthSessionSecret(appEnv.COOKIE_SECRET)

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

			const userId = Number(pendingSession.id)
			const codeValid =
				Number.isInteger(userId) &&
				(await verifyTwoFactorCode({
					db: appEnv.APP_DB,
					userId,
					code,
					type: twoFactorVerificationType,
				}))
			if (!codeValid) {
				void logAuditEvent({
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

			const secure = isSecureRequest(request)
			const headers = new Headers({
				'Cache-Control': 'no-store',
				'Content-Type': 'application/json; charset=utf-8',
			})
			headers.append(
				'Set-Cookie',
				await createAuthCookie(
					{
						id: pendingSession.id,
						email: pendingSession.email,
						rememberMe: pendingSession.rememberMe,
					},
					secure,
				),
			)
			headers.append('Set-Cookie', await destroyVerifySessionCookie(secure))

			void logAuditEvent({
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
