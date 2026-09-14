import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { enum_, object, optional, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	createEmailDestinationVerification,
	emailDestinationRateLimitConfig,
	resendEmailDestinationVerification,
} from '#worker/email/destination-verification.ts'
import {
	EmailDestinationError,
	listEmailNotificationDestinations,
	maxAdditionalEmailNotificationDestinations,
	removeEmailNotificationDestination,
	setDefaultEmailNotificationDestination,
} from '#worker/email/destinations.ts'
import { type routes } from '#universal/routes.ts'

export { emailDestinationRateLimitConfig }

const destinationMutationSchema = object({
	action: enum_(['add', 'resend', 'setDefault', 'remove'] as const),
	email: optional(string()),
	id: optional(string()),
})

function destinationListPayload(
	destinations: Awaited<ReturnType<typeof listEmailNotificationDestinations>>,
) {
	const additionalCount = destinations.filter(
		(destination) => destination.kind === 'additional',
	).length
	return {
		ok: true as const,
		destinations,
		additionalLimit: maxAdditionalEmailNotificationDestinations,
		additionalRemaining: Math.max(
			0,
			maxAdditionalEmailNotificationDestinations - additionalCount,
		),
	}
}

export function createAccountEmailDestinationsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const destinations = await listEmailNotificationDestinations({
					db: env.APP_DB,
					dbUserId: user.userId,
					accountEmail: user.email,
					accountEmailVerified: user.emailVerified,
				})
				return jsonResponse(destinationListPayload(destinations))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse({ ok: false, error: 'Invalid JSON payload.' }, 400)
			}

			const parsed = parseSafe(destinationMutationSchema, body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const action = parsed.value.action
			const email = parsed.value.email?.trim() ?? ''
			const destinationId = parsed.value.id?.trim() ?? ''
			const requestIp = getRequestIp(request) ?? undefined

			if (!user.emailVerified) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_destination',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'email_unverified',
				})
				return jsonResponse(
					{
						ok: false,
						error: 'Verify your account email before managing destinations.',
					},
					403,
				)
			}

			try {
				if (action === 'add' || action === 'resend') {
					if (action === 'add') {
						const result = await createEmailDestinationVerification({
							env,
							userId: user.userId,
							email,
							requestUrl: url,
						})
						const destinations = await listEmailNotificationDestinations({
							db: env.APP_DB,
							dbUserId: user.userId,
							accountEmail: user.email,
							accountEmailVerified: user.emailVerified,
						})
						void logAuditEvent({
							db: auditDatabaseFromEnv(env),
							category: 'account',
							action: 'email_destination',
							result: 'success',
							email: user.email,
							ip: requestIp,
							path: url.pathname,
							reason: `add=${result.destination.email}`,
						})
						return jsonResponse({
							...destinationListPayload(destinations),
							message:
								'Verification email sent. Open the link to start using this address.',
						})
					}

					const destination = await resendEmailDestinationVerification({
						env,
						userId: user.userId,
						destinationId,
						requestUrl: url,
					})
					const destinations = await listEmailNotificationDestinations({
						db: env.APP_DB,
						dbUserId: user.userId,
						accountEmail: user.email,
						accountEmailVerified: user.emailVerified,
					})
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'account',
						action: 'email_destination',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: `resend=${destination.email}`,
					})
					return jsonResponse({
						...destinationListPayload(destinations),
						message: 'Verification email sent again.',
					})
				}

				if (action === 'setDefault') {
					const destinations = await setDefaultEmailNotificationDestination({
						db: env.APP_DB,
						dbUserId: user.userId,
						destinationId,
					})
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'account',
						action: 'email_destination',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: `set_default=${destinationId}`,
					})
					return jsonResponse({
						...destinationListPayload(destinations),
						message: 'Default email destination updated.',
					})
				}

				const destinations = await removeEmailNotificationDestination({
					db: env.APP_DB,
					dbUserId: user.userId,
					destinationId,
				})
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_destination',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: `remove=${destinationId}`,
				})
				return jsonResponse({
					...destinationListPayload(destinations),
					message: 'Email destination removed.',
				})
			} catch (error) {
				if (error instanceof EmailDestinationError) {
					if (error.code === 'rate_limited') {
						void logAuditEvent({
							db: auditDatabaseFromEnv(env),
							category: 'account',
							action: 'email_destination',
							result: 'rate_limited',
							email: user.email,
							ip: requestIp,
							path: url.pathname,
							reason: action,
						})
						return jsonResponse(
							{ ok: false, error: error.message },
							{
								status: 429,
								headers: {
									'Retry-After': String(
										emailDestinationRateLimitConfig.windowSeconds,
									),
								},
							},
						)
					}
					const status =
						error.code === 'not_found'
							? 404
							: error.code === 'at_cap'
								? 409
								: 400
					return jsonResponse({ ok: false, error: error.message }, status)
				}
				if (
					error instanceof Error &&
					(error.message === 'Email destination was not found.' ||
						error.message === 'That address is already verified.')
				) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Failed to update email destinations:', error)
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_destination',
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
							'Unable to update email destinations. Please try again later.',
					},
					502,
				)
			}
		},
	} satisfies Action<typeof routes.accountEmailDestinationsApiPost>
}
