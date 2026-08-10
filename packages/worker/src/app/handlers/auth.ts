import { type Action } from 'remix/router'
import { enum_, object, parseSafe, string } from 'remix/data-schema'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
} from '#app/auth-session.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { createEmailVerification } from '#app/email-verification.ts'
import {
	consumeInviteCode,
	getInviteFailureMessage,
	normalizeInviteCode,
	releaseInviteUse,
} from '#app/invites.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import { type routes } from '#universal/routes.ts'
import {
	getUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import {
	parseStoredPlanName,
	resolvePlanWrite,
	type PlanName,
} from '#universal/plans.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import {
	createStableUserIdFromEmail,
	resolveUserStableId,
} from '#worker/user-id.ts'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import { maybeTagKitSubscriberOnSignup } from '#app/kit-signup.ts'
import { verifyPublicFormProtection } from '#app/public-form-protection.ts'
import { getSignupMode } from '#universal/signup-mode.ts'
import { followDefaultWelcomeAccounts } from '#worker/community/welcome-follow.ts'

const authModes = ['login', 'signup'] as const
type AuthMode = (typeof authModes)[number]

const authRequestSchema = object({
	email: string(),
	password: string(),
	mode: enum_(authModes),
})

const dummyPasswordHash =
	'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'

export function createAuthHandler(env: Env) {
	const db = createDb(env.APP_DB)

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

			const protection = await verifyPublicFormProtection({
				env,
				request,
				body:
					typeof body === 'object' && body !== null
						? (body as Record<string, unknown>)
						: {},
			})
			if (!protection.ok) return protection.response

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
			const inviteCode =
				typeof body === 'object' && body !== null
					? (body as Record<string, unknown>).inviteCode
					: undefined
			const rememberMeValue =
				typeof body === 'object' && body !== null
					? (body as Record<string, unknown>).rememberMe
					: undefined
			const signupRedirectTo =
				normalizedMode === 'signup' &&
				typeof body === 'object' &&
				body !== null &&
				typeof (body as Record<string, unknown>).redirectTo === 'string'
					? normalizeRedirectTo(
							(body as Record<string, unknown>).redirectTo as string,
						)
					: null
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
				let consumedInviteCode: string | null = null
				let consumedInvitePlan: PlanName | null = null
				async function releaseConsumedInvite() {
					if (!consumedInviteCode) return
					await releaseInviteUse({
						db: env.APP_DB,
						code: consumedInviteCode,
					})
					consumedInviteCode = null
					consumedInvitePlan = null
				}

				const inviteRequired = getSignupMode(env) !== 'open'
				if (inviteRequired || normalizeInviteCode(inviteCode)) {
					const inviteResult = await consumeInviteCode({
						db: env.APP_DB,
						code: inviteCode,
					})
					if (!inviteResult.ok) {
						void logAuditEvent({
							category: 'auth',
							action: 'signup',
							result: 'failure',
							email: normalizedEmail,
							ip: requestIp,
							path: url.pathname,
							reason: `invite_${inviteResult.reason}`,
						})
						return Response.json(
							{ error: getInviteFailureMessage(inviteResult.reason) },
							{
								status:
									inviteResult.reason === 'missing' && inviteRequired
										? 400
										: 403,
							},
						)
					}
					consumedInviteCode = inviteResult.invite.code
					consumedInvitePlan = parseStoredPlanName(inviteResult.invite.plan)
				}

				let record: { id: number; stableUserId: string } | null = null
				try {
					const stableUserId =
						await createStableUserIdFromEmail(normalizedEmail)
					const createdUser = await db.create(
						usersTable,
						{
							username: normalizedUsername,
							email: normalizedEmail,
							stable_user_id: stableUserId,
							password_hash: passwordHash,
							plan: resolvePlanWrite(consumedInvitePlan),
						},
						{
							returnRow: true,
						},
					)
					record = { id: createdUser.id, stableUserId }
				} catch (error) {
					const uniqueField = getUniqueConstraintField(error)
					if (uniqueField === 'email' || uniqueField === 'username') {
						await releaseConsumedInvite()
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
					await releaseConsumedInvite()
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
					await releaseConsumedInvite()
					return Response.json(
						{ error: 'Unable to create account.' },
						{ status: 500 },
					)
				}

				// INSERT OR IGNORE affects zero rows when the seeded `user` role is
				// missing (partial migration). Fail loudly rather than creating an
				// account with no roles or permissions.
				let assigned = false
				try {
					;({ assigned } = await assignUserRole({
						db: env.APP_DB,
						userId: record.id,
						roleName: 'user',
					}))
				} catch (error) {
					console.error('Failed to assign default role at signup:', error)
				}
				if (!assigned) {
					// Remove the just-created user row so the signup can be retried;
					// otherwise the email/username would be stuck as "already
					// registered" on an account that has no roles.
					try {
						await env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
							.bind(record.id)
							.run()
					} catch (error) {
						console.error(
							'Failed to remove user row after role assignment failure:',
							error,
						)
					}
					await releaseConsumedInvite()
					void logAuditEvent({
						category: 'auth',
						action: 'signup',
						result: 'failure',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: 'default_role_assignment_failed',
					})
					return Response.json(
						{ error: 'Unable to create account.' },
						{ status: 500 },
					)
				}

				try {
					await createEmailVerification({
						env,
						userId: record.id,
						email: normalizedEmail,
						requestUrl: url,
						redirectTo: signupRedirectTo,
					})
				} catch (error) {
					console.error('Failed to create email verification at signup:', error)
					try {
						await env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
							.bind(record.id)
							.run()
					} catch (deleteError) {
						console.error(
							'Failed to remove user row after verification setup failure:',
							deleteError,
						)
					}
					await releaseConsumedInvite()
					void logAuditEvent({
						category: 'auth',
						action: 'signup',
						result: 'failure',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: 'email_verification_setup_failed',
					})
					return Response.json(
						{
							error:
								'Unable to send the verification email. Please try signing up again.',
						},
						{ status: 500 },
					)
				}

				// Best-effort: the automatic {username}@<platform domain> inbox is
				// also provisioned on first inbound mail, so a failure here must
				// not fail the signup.
				const platformEmailDomain = getPlatformEmailDomain(env)
				if (platformEmailDomain) {
					try {
						await ensureDefaultEmailInbox({
							db: env.APP_DB,
							userId: await createStableUserIdFromEmail(normalizedEmail),
							username: normalizedUsername,
							domain: platformEmailDomain,
						})
					} catch (error) {
						console.warn(
							'Failed to provision default email inbox at signup:',
							error,
						)
					}
				}

				// Best-effort: if this email is already in Kit (e.g. waitlist),
				// add signed_up::kody without removing other tags.
				await maybeTagKitSubscriberOnSignup({
					env,
					email: normalizedEmail,
				})
				await followDefaultWelcomeAccounts({
					db: env.APP_DB,
					followerUserId: record.stableUserId,
				})

				const cookie = await createAuthCookie(
					{
						stableUserId: record.stableUserId,
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
				if (consumedInviteCode) {
					void logAuditEvent({
						category: 'auth',
						action: 'invite_use',
						result: 'success',
						email: normalizedEmail,
						ip: requestIp,
						path: url.pathname,
						reason: `invite_code=${consumedInviteCode};stable_user_id=${record.stableUserId};plan=${resolvePlanWrite(consumedInvitePlan)}`,
					})
				}
				return Response.json(
					{
						ok: true,
						mode: normalizedMode,
						emailVerificationRequired: true,
						message: 'Check your email to verify your account.',
					},
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

			// Two-factor accounts get a short-lived pending cookie instead of a
			// session; the real session cookie is only issued once the TOTP code
			// passes at POST /verify/2fa.json.
			if (await isTwoFactorEnabled(env.APP_DB, userRecord.id)) {
				setVerifySessionSecret(env.COOKIE_SECRET)
				const secure = isSecureRequest(request)
				const verifyCookie = await createVerifySessionCookie(
					{
						stableUserId: resolveUserStableId(userRecord),
						email: normalizedEmail,
						rememberMe,
					},
					secure,
				)
				void logAuditEvent({
					category: 'auth',
					action: 'login_2fa_challenge',
					result: 'success',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
				})
				const headers = new Headers()
				headers.append('Set-Cookie', verifyCookie)
				// A pre-existing session must not stay usable while the second
				// factor is still pending for this new login.
				headers.append('Set-Cookie', await destroyAuthCookie(secure))
				return Response.json(
					{ ok: true, mode: normalizedMode, requiresTwoFactor: true },
					{ headers },
				)
			}

			const cookie = await createAuthCookie(
				{
					stableUserId: resolveUserStableId(userRecord),
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
