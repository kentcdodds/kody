import { type Action } from 'remix/router'
import { enum_, object, parseSafe, string } from 'remix/data-schema'
import { createAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { normalizeEmail } from '#app/normalize-email.ts'
import { type routes } from '#app/routes.ts'
import { getUsernameValidationError, normalizeUsername } from '#app/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { type AppEnv } from '#worker/env-schema.ts'

const authModes = ['login', 'signup'] as const
type AuthMode = (typeof authModes)[number]

/**
 * Signups are blocked in real deployments and allowed in local dev,
 * preview, and e2e test runs so the existing tooling (Playwright seed
 * helpers, manual local testing) keeps working without a second
 * auth-bypass code path. Production wrangler env sets
 * `SENTRY_ENVIRONMENT: 'production'`; preview/test set 'preview' /
 * 'test'; `npm run dev` sets `WRANGLER_IS_LOCAL_DEV=true`.
 */
function isSignupAllowed(appEnv: AppEnv) {
	return isNonProductionRuntime(
		appEnv as unknown as {
			WRANGLER_IS_LOCAL_DEV?: string
			SENTRY_ENVIRONMENT?: string
		},
	)
}

const authRequestSchema = object({
	email: string(),
	password: string(),
	mode: enum_(authModes),
})

const dummyPasswordHash =
	'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'

export function createAuthHandler(appEnv: AppEnv) {
	const db = createDb(appEnv.APP_DB)

	return {
		middleware: [],
		async handler({ request, url }) {
			let body: unknown

			try {
				body = await request.json()
			} catch {
				return Response.json(
					{ error: 'Invalid JSON payload.' },
					{ status: 400 },
				)
			}

			const parsedBody = parseSafe(authRequestSchema, body)
			if (!parsedBody.success) {
				return Response.json(
					{ error: 'Invalid request body.' },
					{ status: 400 },
				)
			}

			const normalizedEmail = normalizeEmail(parsedBody.value.email)
			const normalizedPassword = parsedBody.value.password
			const normalizedMode: AuthMode = parsedBody.value.mode
			const normalizedUsername = normalizeUsername(
				typeof body === 'object' && body !== null
					? (body as Record<string, unknown>).username
					: undefined,
			)
			const rememberMeValue =
				typeof body === 'object' && body !== null
					? (body as Record<string, unknown>).rememberMe
					: undefined
			const requestIp = getRequestIp(request) ?? undefined
			if (
				rememberMeValue !== undefined &&
				typeof rememberMeValue !== 'boolean'
			) {
				return Response.json(
					{ error: 'Invalid request body.' },
					{ status: 400 },
				)
			}
			const rememberMe = normalizedMode === 'login' && rememberMeValue === true

			if (!normalizedEmail || !normalizedPassword) {
				void logAuditEvent({
					category: 'auth',
					action: 'authenticate',
					result: 'failure',
					email: normalizedEmail || undefined,
					ip: requestIp,
					path: url.pathname,
					reason: 'missing_fields',
				})
				return Response.json(
					{ error: 'Email, password, and mode are required.' },
					{ status: 400 },
				)
			}
			if (normalizedMode === 'signup' && !isSignupAllowed(appEnv)) {
				void logAuditEvent({
					category: 'auth',
					action: 'signup',
					result: 'failure',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
					reason: 'signup_disabled',
				})
				return Response.json(
					{ error: 'Signups are disabled.' },
					{ status: 403 },
				)
			}
			if (normalizedMode === 'signup') {
				const usernameError = getUsernameValidationError(normalizedUsername)
				if (usernameError) {
					void logAuditEvent({
						category: 'auth',
						action: 'signup',
						result: 'failure',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: 'invalid_username',
					})
					return Response.json({ error: usernameError }, { status: 400 })
				}
				const passwordError = getPasswordPolicyError(normalizedPassword)
				if (passwordError) {
					void logAuditEvent({
						category: 'auth',
						action: 'signup',
						result: 'failure',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: 'weak_password',
					})
					return Response.json({ error: passwordError }, { status: 400 })
				}
			}

			if (normalizedMode === 'signup') {
				const existingUser = await db.findOne(usersTable, {
					where: { email: normalizedEmail },
				})
				if (existingUser) {
					void logAuditEvent({
						category: 'auth',
						action: 'signup',
						result: 'failure',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: 'email_exists',
					})
					return Response.json(
						{ error: 'Email already registered.' },
						{ status: 409 },
					)
				}
				const existingUsername = await db.findOne(usersTable, {
					where: { username: normalizedUsername },
				})
				if (existingUsername) {
					void logAuditEvent({
						category: 'auth',
						action: 'signup',
						result: 'failure',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: 'username_exists',
					})
					return Response.json(
						{ error: 'Username already registered.' },
						{ status: 409 },
					)
				}

				const passwordHash = await createPasswordHash(normalizedPassword)
				let record: { id: number } | null = null
				try {
					const createdUser = await db.create(
						usersTable,
						{
							username: normalizedUsername,
							email: normalizedEmail,
							password_hash: passwordHash,
						},
						{
							returnRow: true,
						},
					)
					record = { id: createdUser.id }
				} catch (error) {
					const uniqueField = getUniqueConstraintField(error)
					if (uniqueField === 'email' || uniqueField === 'username') {
						const isUsernameConflict = uniqueField === 'username'
						void logAuditEvent({
							category: 'auth',
							action: 'signup',
							result: 'failure',
							email: normalizedEmail,
							ip: requestIp,
							path: url.pathname,
							reason: isUsernameConflict ? 'username_exists' : 'email_exists',
						})
						return Response.json(
							{
								error: isUsernameConflict
									? 'Username already registered.'
									: 'Email already registered.',
							},
							{ status: 409 },
						)
					}
					throw error
				}
				if (!record) {
					void logAuditEvent({
						category: 'auth',
						action: 'signup',
						result: 'failure',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: 'insert_failed',
					})
					return Response.json(
						{ error: 'Unable to create account.' },
						{ status: 500 },
					)
				}

				const cookie = await createAuthCookie(
					{
						id: String(record.id),
						email: normalizedEmail,
						rememberMe: false,
					},
					isSecureRequest(request),
				)
				void logAuditEvent({
					category: 'auth',
					action: 'signup',
					result: 'success',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
				})
				return Response.json(
					{ ok: true, mode: normalizedMode },
					{
						headers: {
							'Set-Cookie': cookie,
						},
					},
				)
			}

			const userRecord = await db.findOne(usersTable, {
				where: { email: normalizedEmail },
			})
			let passwordValid = false
			if (userRecord) {
				passwordValid = await verifyPassword(
					normalizedPassword,
					userRecord.password_hash,
				)
			} else {
				await verifyPassword(normalizedPassword, dummyPasswordHash)
			}
			if (!userRecord || !passwordValid) {
				void logAuditEvent({
					category: 'auth',
					action: 'login',
					result: 'failure',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_credentials',
				})
				return Response.json(
					{ error: 'Invalid email or password.' },
					{ status: 401 },
				)
			}

			const cookie = await createAuthCookie(
				{
					id: String(userRecord.id),
					email: normalizedEmail,
					rememberMe,
				},
				isSecureRequest(request),
			)
			void logAuditEvent({
				category: 'auth',
				action: 'login',
				result: 'success',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
			})
			return Response.json(
				{ ok: true, mode: normalizedMode },
				{
					headers: {
						'Set-Cookie': cookie,
					},
				},
			)
		},
	} satisfies Action<typeof routes.auth>
}
