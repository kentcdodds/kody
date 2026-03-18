import { type BuildAction } from 'remix/fetch-router'
import { enum_, object, parseSafe, string } from 'remix/data-schema'
import { createAuthCookie, isSecureRequest } from '#server/auth-session.ts'
import { getRequestIp, logAuditEvent } from '#server/audit-log.ts'
import { normalizeEmail } from '#server/normalize-email.ts'
import { createPasswordHash, verifyPassword } from '#server/password-hash.ts'
import { type routes } from '#server/routes.ts'
import { type AppEnv } from '#types/env-schema.ts'
import { createDb, usersTable } from '#worker/db.ts'

const authModes = ['login', 'signup'] as const
type AuthMode = (typeof authModes)[number]

function isUniqueConstraintError(error: unknown) {
	return (
		error instanceof Error && /unique constraint failed/i.test(error.message)
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
		async action({ request, url }) {
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

				const passwordHash = await createPasswordHash(normalizedPassword)
				const username = normalizedEmail
				let record: { id: number } | null = null
				try {
					const createdUser = await db.create(
						usersTable,
						{
							username,
							email: normalizedEmail,
							password_hash: passwordHash,
						},
						{
							returnRow: true,
						},
					)
					record = { id: createdUser.id }
				} catch (error) {
					if (isUniqueConstraintError(error)) {
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
	} satisfies BuildAction<typeof routes.auth.method, typeof routes.auth.pattern>
}
