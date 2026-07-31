import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import { createDb, passwordResetsTable, usersTable } from '#worker/db.ts'
import {
	logAuditEvent,
	getRequestIp,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	createPasswordResetToken,
	hashPasswordResetToken,
	passwordResetTokenExpiryMs,
} from '#worker/identity/password-reset-tokens.ts'
import { type routes } from '#app/routes.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import { verifyPublicFormProtection } from '#app/public-form-protection.ts'

const resetRequestSchema = object({
	email: string(),
})

const resetConfirmSchema = object({
	token: string(),
	password: string(),
})

function buildResetEmail(resetUrl: string) {
	return {
		subject: 'Reset your kody password',
		text: [
			'We received a request to reset your kody password.',
			`Reset your password: ${resetUrl}`,
			'If you did not request a reset, you can safely ignore this email.',
		].join('\n\n'),
		html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Password reset</title>
  </head>
  <body>
    <p>We received a request to reset your kody password.</p>
    <p><a href="${resetUrl}">Reset your password</a></p>
    <p>If you did not request a reset, you can safely ignore this email.</p>
  </body>
</html>`,
	}
}

function logMissingEmailConfig(payload: { to: string; subject: string }) {
	console.warn(
		'password-reset-email-sender-unconfigured',
		JSON.stringify({
			to: redactEmailRecipient(payload.to),
			subject: payload.subject,
		}),
	)
}

function getPasswordResetEmailConfig(env: Pick<Env, 'APP_BASE_URL'>) {
	const configuredBaseUrl = env.APP_BASE_URL?.trim()
	if (!configuredBaseUrl) return null

	const appBaseUrl = new URL(configuredBaseUrl).origin
	const fromEmail = `kody@${new URL(configuredBaseUrl).hostname}`
	return { appBaseUrl, fromEmail }
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
			const emailConfig = userRecord ? getPasswordResetEmailConfig(env) : null

			const expiresAt = Date.now() + passwordResetTokenExpiryMs
			const resetToken = userRecord
				? await createPasswordResetToken({
						db: env.APP_DB,
						userId: userRecord.id,
						expiresAt,
					})
				: null

			const token = resetToken?.token ?? ''

			if (userRecord) {
				const resetUrl = new URL(
					'/reset-password',
					emailConfig?.appBaseUrl ?? url,
				)
				resetUrl.searchParams.set('token', token)
				const email = buildResetEmail(resetUrl.toString())

				if (!emailConfig) {
					logMissingEmailConfig({
						to: normalizedEmail,
						subject: email.subject,
					})
				} else {
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
				}

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

			const passwordHash = await createPasswordHash(password)
			// Millisecond ISO so same-second re-login after reset is not
			// invalidated by second-truncated CURRENT_TIMESTAMP-style values.
			await db.update(usersTable, resetRecord.user_id, {
				password_hash: passwordHash,
				password_changed_at: new Date().toISOString(),
				updated_at: utcSqliteTimestamp(),
			})
			await db.deleteMany(passwordResetsTable, {
				where: { user_id: resetRecord.user_id },
			})

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
