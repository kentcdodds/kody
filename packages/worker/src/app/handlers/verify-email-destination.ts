import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	verifyEmailDestinationToken,
	type VerifyEmailDestinationReason,
} from '#worker/email/destination-verification.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

const emailDestinationsHref = '/account/email#email-destinations'

function getVerifyEmailDestinationError(reason: VerifyEmailDestinationReason) {
	switch (reason) {
		case 'missing_token':
			return 'Verification token is required. Open the link from the latest verification email, or resend it from your email inbox.'
		case 'invalid_token':
			return 'This email destination link is invalid or is no longer active. Open the latest verification email, or resend the link from your email inbox.'
		case 'expired_token':
			return 'This email destination link has expired. Resend a new link from your email inbox.'
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
			const consume = request.method !== 'HEAD'
			const result = await verifyEmailDestinationToken({
				db: env.APP_DB,
				token: url.searchParams.get('token'),
				consume,
			})

			if (request.method === 'HEAD') {
				return new Response(null, { status: result.ok ? 200 : 400 })
			}

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
					title: 'Verify email destination',
					status: 400,
					loaderData: {
						emailVerification: {
							ok: false,
							kind: 'email_destination',
							reason: result.reason,
							error: getVerifyEmailDestinationError(result.reason),
							ctaHref: emailDestinationsHref,
							ctaLabel: 'Resend from email inbox',
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
				title: 'Email destination verified',
				loaderData: {
					emailVerification: {
						ok: true,
						kind: 'email_destination',
						message:
							'emailSend can now use this address. Mail comes from your platform inbox. Set it as the default from the email inbox if you want omitted `to` to use it.',
						ctaHref: emailDestinationsHref,
						ctaLabel: 'Go to email inbox',
					},
				},
			})
		},
	} satisfies Action<typeof routes.verifyEmailDestination>
}
