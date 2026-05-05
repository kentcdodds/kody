import { type BuildAction } from 'remix/fetch-router'
import { object, parseSafe, string } from 'remix/data-schema'
import { createDb, passwordResetsTable, usersTable } from '#worker/db.ts'
import {
	logAuditEvent,
	getRequestIp,
	redactEmailRecipient,
} from '#app/audit-log.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { normalizeEmail } from '#app/normalize-email.ts'
import { type routes } from '#app/routes.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { type AppEnv } from '#worker/env-schema.ts'

const resetTokenBytes = 32
const resetTokenExpiryMs = 60 * 60 * 1000

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

function generateResetToken() {
	const bytes = new Uint8Array(resetTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

async function hashResetToken(token: string) {
	const data = new TextEncoder().encode(token)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(digest))
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

function getPasswordResetEmailConfig(appEnv: Pick<AppEnv, 'APP_BASE_URL'>) {
	const configuredBaseUrl = appEnv.APP_BASE_URL?.trim()
	if (!configuredBaseUrl) return null

	try {
		const appBaseUrl = new URL(configuredBaseUrl).origin
		const fromEmail = `kody@${new URL(configuredBaseUrl).hostname}`
		return { appBaseUrl, fromEmail }
	} catch {
		return null
	}
}

export function createPasswordResetRequestHandler(appEnv: AppEnv) {
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

			const token = generateResetToken()
			const tokenHash = await hashResetToken(token)
			const expiresAt = Date.now() + resetTokenExpiryMs

			if (userRecord) {
				await db.deleteMany(passwordResetsTable, {
					where: { user_id: userRecord.id },
				})
				await db.create(passwordResetsTable, {
					user_id: userRecord.id,
					token_hash: tokenHash,
					expires_at: expiresAt,
				})
			}

			if (userRecord) {
				const emailConfig = getPasswordResetEmailConfig(appEnv)
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
								accountId: appEnv.CLOUDFLARE_ACCOUNT_ID,
								apiBaseUrl: appEnv.CLOUDFLARE_API_BASE_URL,
								apiToken: appEnv.CLOUDFLARE_API_TOKEN,
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
	} satisfies BuildAction<
		typeof routes.passwordResetRequest.method,
		typeof routes.passwordResetRequest.pattern
	>
}

export function createPasswordResetConfirmHandler(appEnv: AppEnv) {
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

			const tokenHash = await hashResetToken(token)
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
			await db.update(usersTable, resetRecord.user_id, {
				password_hash: passwordHash,
				updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
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
	} satisfies BuildAction<
		typeof routes.passwordResetConfirm.method,
		typeof routes.passwordResetConfirm.pattern
	>
}
