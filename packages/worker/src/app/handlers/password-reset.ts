import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import { createDb, passwordResetsTable, usersTable } from '#worker/db.ts'
import {
	logAuditEvent,
	getRequestIp,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import { deferWork } from '#worker/deferred-work.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	createPasswordResetToken,
	hashPasswordResetToken,
	passwordResetTokenExpiryMs,
} from '#worker/identity/password-reset-tokens.ts'
import { type routes } from '#universal/routes.ts'
import { applyPasswordChange } from '#app/apply-password-change.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import { verifyPublicFormProtection } from '#app/public-form-protection.ts'
import { buildPasswordResetEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import { resolveUserStableId } from '#worker/user-id.ts'

const resetRequestSchema = object({
	email: string(),
})

const resetConfirmSchema = object({
	token: string(),
	password: string(),
})

function logMissingEmailConfig(payload: { to: string; subject: string }) {
	console.warn(
		'password-reset-email-sender-unconfigured',
		JSON.stringify({
			to: redactEmailRecipient(payload.to),
			subject: payload.subject,
		}),
	)
}

function getPasswordResetEmailConfig(
	env: Pick<Env, 'APP_BASE_URL' | 'SYSTEM_EMAIL_DOMAIN'> & {
		WRANGLER_IS_LOCAL_DEV?: string
	},
	requestUrl?: string | URL,
) {
	return resolveTransactionalEmailConfig({
		env,
		requestUrl: env.WRANGLER_IS_LOCAL_DEV === 'true' ? requestUrl : undefined,
	})
}

export function createPasswordResetRequestHandler(env: Env) {
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
			const parsed = parseSafe(resetRequestSchema, body)
			const requestIp = getRequestIp(request) ?? undefined
			const normalizedEmail = parsed.success
				? normalizeEmail(parsed.value.email)
				: ''

			if (!parsed.success || !normalizedEmail) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_request',
					result: 'failure',
					email: normalizedEmail || undefined,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_payload',
				})
				return Response.json({ error: 'Email is required.' }, { status: 400 })
			}

			const userRecord = await db.findOne(usersTable, {
				where: { email: normalizedEmail },
			})

			if (userRecord) {
				const userId = userRecord.id
				// Token writes and the email send happen after the response so
				// the reply latency does not depend on whether the address is
				// registered; the uniform message body alone would still leak
				// account existence through a timing side channel.
				void deferWork('password-reset-request-error', async () => {
					const emailConfig = getPasswordResetEmailConfig(env, url)
					const resetToken = await createPasswordResetToken({
						db: env.APP_DB,
						userId,
						expiresAt: Date.now() + passwordResetTokenExpiryMs,
					})
					const appBaseUrl = new URL(emailConfig?.appBaseUrl ?? url).origin
					const resetUrl = new URL('/reset-password', appBaseUrl)
					resetUrl.searchParams.set('token', resetToken.token)
					const email = buildPasswordResetEmail({
						appBaseUrl,
						resetUrl: resetUrl.toString(),
					})

					if (!emailConfig) {
						logMissingEmailConfig({
							to: normalizedEmail,
							subject: email.subject,
						})
						return
					}

					try {
						await sendCloudflareEmail(
							{
								accountId: env.CLOUDFLARE_ACCOUNT_ID,
								apiBaseUrl: env.CLOUDFLARE_API_BASE_URL,
								apiToken: env.CLOUDFLARE_API_TOKEN,
							},
							{
								to: normalizedEmail,
								from: emailConfig.fromEmail,
								subject: email.subject,
								html: email.html,
								text: email.text,
							},
						)
					} catch (error) {
						console.warn('cloudflare-email-error', error)
					}
				})

				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_request',
					result: 'success',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
				})
			} else {
				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_request',
					result: 'failure',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
					reason: 'email_not_found',
				})
			}

			return Response.json({
				ok: true,
				message: 'If the account exists, a reset email has been sent.',
			})
		},
	} satisfies Action<typeof routes.passwordResetRequest>
}

export function createPasswordResetConfirmHandler(env: Env) {
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
			const parsed = parseSafe(resetConfirmSchema, body)
			const requestIp = getRequestIp(request) ?? undefined
			const token = parsed.success ? parsed.value.token.trim() : ''
			const password = parsed.success ? parsed.value.password : ''

			if (!parsed.success || !token || !password) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_confirm',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_payload',
				})
				return Response.json(
					{ error: 'Token and password are required.' },
					{ status: 400 },
				)
			}

			const passwordError = getPasswordPolicyError(password)
			if (passwordError) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_confirm',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: 'weak_password',
				})
				return Response.json({ error: passwordError }, { status: 400 })
			}

			const tokenHash = await hashPasswordResetToken(token)
			const resetRecord = await db.findOne(passwordResetsTable, {
				where: { token_hash: tokenHash },
			})
			const now = Date.now()

			if (!resetRecord || resetRecord.expires_at < now) {
				if (resetRecord && resetRecord.expires_at < now) {
					await db.delete(passwordResetsTable, resetRecord.id)
				}
				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_confirm',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: resetRecord ? 'expired_token' : 'invalid_token',
				})
				return Response.json(
					{ error: 'Reset link is invalid or expired.' },
					{ status: 400 },
				)
			}

			const userRecord = await db.findOne(usersTable, {
				where: { id: resetRecord.user_id },
			})
			if (!userRecord) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_confirm',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: 'user_not_found',
				})
				return Response.json(
					{ error: 'Reset link is invalid or expired.' },
					{ status: 400 },
				)
			}

			const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthGrantHelpers })
				.OAUTH_PROVIDER
			const result = await applyPasswordChange({
				db,
				helpers,
				userId: resetRecord.user_id,
				stableUserId: resolveUserStableId(userRecord),
				password,
			})
			if (!result.ok) {
				void logAuditEvent({
					category: 'auth',
					action: 'password_reset_confirm',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason:
						result.reason === 'oauth_grant_revoke_failed'
							? result.detail
							: result.reason,
				})
				return Response.json(
					{ error: 'Unable to finish password reset right now.' },
					{ status: 500 },
				)
			}

			void logAuditEvent({
				category: 'auth',
				action: 'password_reset_confirm',
				result: 'success',
				ip: requestIp,
				path: url.pathname,
			})

			return Response.json({ ok: true })
		},
	} satisfies Action<typeof routes.passwordResetConfirm>
}
