import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { createEmailChangeVerification } from '#app/email-change.ts'
import { normalizeEmail } from '#app/normalize-email.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { type routes } from '#app/routes.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { type AppEnv } from '#worker/env-schema.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

export const emailChangeRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

const emailChangeRequestSchema = object({
	email: string(),
	password: string(),
})

function getEmailValidationError(email: string) {
	if (!email) return 'Email is required.'
	if (email.length > 254) return 'Email is too long.'
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return 'Enter a valid email address.'
	}
	return null
}

export function createAccountEmailChangeHandler(appEnv: AppEnv) {
	const env = appEnv as unknown as Env
	const db = createDb(appEnv.APP_DB)

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

			const parsed = parseSafe(emailChangeRequestSchema, body)
			const requestIp = getRequestIp(request) ?? undefined
			const newEmail = parsed.success ? normalizeEmail(parsed.value.email) : ''
			const password = parsed.success ? parsed.value.password : ''
			const validationError = parsed.success
				? getEmailValidationError(newEmail)
				: 'Invalid request body.'
			if (validationError) {
				void logAuditEvent({
					category: 'account',
					action: 'email_change_request',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_payload',
				})
				return jsonResponse({ ok: false, error: validationError }, 400)
			}

			if (newEmail === normalizeEmail(user.email)) {
				return jsonResponse(
					{ ok: false, error: 'Enter a different email address.' },
					400,
				)
			}

			const userRecord = await db.findOne(usersTable, {
				where: { id: user.userId },
			})
			if (!userRecord) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const rateLimitKey = `email-change:user:${user.userId}`
			const rateLimit = await checkRateLimit(
				appEnv.APP_DB,
				rateLimitKey,
				emailChangeRateLimitConfig,
			)
			if (!rateLimit.allowed) {
				void logAuditEvent({
					category: 'account',
					action: 'email_change_request',
					result: 'rate_limited',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})
				return jsonResponse(
					{
						ok: false,
						error: 'Too many email change requests. Please try again later.',
					},
					{
						status: 429,
						headers: {
							'Retry-After': String(rateLimit.retryAfterSeconds ?? 60),
						},
					},
				)
			}

			const passwordValid = await verifyPassword(
				password,
				userRecord.password_hash,
			)
			if (!passwordValid) {
				void logAuditEvent({
					category: 'account',
					action: 'email_change_request',
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
						error: 'Password is incorrect.',
					},
					401,
				)
			}

			const existingUser = await db.findOne(usersTable, {
				where: { email: newEmail },
			})
			if (existingUser) {
				void logAuditEvent({
					category: 'account',
					action: 'email_change_request',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'email_exists',
				})
				return jsonResponse(
					{ ok: false, error: 'Email already registered.' },
					409,
				)
			}

			try {
				await createEmailChangeVerification({
					appEnv,
					userId: user.userId,
					currentEmail: user.email,
					newEmail,
					requestUrl: url,
				})
			} catch (error) {
				await releaseRateLimit(appEnv.APP_DB, rateLimitKey).catch(
					() => undefined,
				)
				const uniqueField = getUniqueConstraintField(error)
				if (uniqueField === 'new_email') {
					return jsonResponse(
						{ ok: false, error: 'Email change is already pending.' },
						409,
					)
				}
				console.error('Failed to request email change:', error)
				void logAuditEvent({
					category: 'account',
					action: 'email_change_request',
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
							'Unable to send the email change verification. Please try again later.',
					},
					502,
				)
			}

			void logAuditEvent({
				category: 'account',
				action: 'email_change_request',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: `new_email=${newEmail}`,
			})
			return jsonResponse({
				ok: true,
				message: 'Verification email sent to your new address.',
			})
		},
	} satisfies Action<typeof routes.accountEmailChange>
}
