import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { verifyEmailToken } from '#app/email-verification.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { sendConnectAgentEmail } from '#app/user-account-emails.ts'
import { resolveVerifyEmailSuccessCta } from '#universal/safe-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

function getVerifyEmailError(
	reason: 'missing_token' | 'invalid_token' | 'expired_token',
) {
	switch (reason) {
		case 'missing_token':
			return 'Verification token is required.'
		case 'invalid_token':
			return 'Verification link is invalid.'
		case 'expired_token':
			return 'Verification link has expired.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export function createVerifyEmailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const result = await verifyEmailToken({
				db: env.APP_DB,
				token: url.searchParams.get('token'),
			})
			const requestIp = getRequestIp(request) ?? undefined

			if (!result.ok) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'email_verify',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: result.reason,
				})
				return renderAppPage({
					request,
					env,
					title: 'Verify email',
					status: 400,
					loaderData: {
						emailVerification: {
							ok: false,
							error: getVerifyEmailError(result.reason),
						},
					},
				})
			}

			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'email_verify',
				result: 'success',
				email: result.email,
				ip: requestIp,
				path: url.pathname,
			})
			if (result.newlyVerified) {
				void sendConnectAgentEmail({
					env,
					email: result.email,
					userId: result.stableUserId,
				}).catch((error) => {
					console.warn('connect-agent-email-failed', error)
				})
				scheduleKitSubscriberSync({
					env,
					email: result.email,
					stableUserId: result.stableUserId,
				})
			}
			const cta = resolveVerifyEmailSuccessCta(
				url.searchParams.get('redirectTo'),
			)
			return renderAppPage({
				request,
				env,
				title: 'Email verified',
				loaderData: {
					emailVerification: {
						ok: true,
						kind: 'email_verify',
						message: cta.message,
						ctaHref: cta.href,
						ctaLabel: cta.label,
					},
				},
			})
		},
	} satisfies Action<typeof routes.verifyEmail>
}
