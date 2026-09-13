import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { verifyEmailDestinationToken } from '#worker/email/destination-verification.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

function getVerifyEmailDestinationError(
	reason: 'missing_token' | 'invalid_token' | 'expired_token',
) {
	switch (reason) {
		case 'missing_token':
			return 'Verification token is required.'
		case 'invalid_token':
			return 'Notification destination link is invalid.'
		case 'expired_token':
			return 'Notification destination link has expired.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export function createVerifyEmailDestinationHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const result = await verifyEmailDestinationToken({
				db: env.APP_DB,
				token: url.searchParams.get('token'),
			})
			const requestIp = getRequestIp(request) ?? undefined

			if (!result.ok) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_destination_verify',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: result.reason,
				})
				return renderAppPage({
					request,
					env,
					title: 'Verify notification address',
					status: 400,
					loaderData: {
						emailVerification: {
							ok: false,
							error: getVerifyEmailDestinationError(result.reason),
						},
					},
				})
			}

			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: 'email_destination_verify',
				result: 'success',
				email: result.email,
				ip: requestIp,
				path: url.pathname,
			})
			return renderAppPage({
				request,
				env,
				title: 'Notification address verified',
				loaderData: {
					emailVerification: {
						ok: true,
						kind: 'email_destination',
						message:
							'This address can now receive Kody notification email. Set it as the default from Account settings if you want emailSend without a `to` to use it.',
						ctaHref: '/account',
						ctaLabel: 'Go to account',
					},
				},
			})
		},
	} satisfies Action<typeof routes.verifyEmailDestination>
}
