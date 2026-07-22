import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { normalizeEmail } from '#app/normalize-email.ts'
import { createDb, pendingEmailChangesTable } from '#worker/db.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import { toHex } from '@kody-internal/shared/hex.ts'

const emailChangeTokenBytes = 32
const emailChangeTokenExpiryMs = 24 * 60 * 60 * 1000
function generateEmailChangeToken() {
	const bytes = new Uint8Array(emailChangeTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

function getEmailChangeConfig(input: {
	env: Pick<Env, 'APP_BASE_URL'>
	requestUrl: string | URL
}) {
	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	const appBaseUrl = new URL(configuredBaseUrl || input.requestUrl).origin
	const fromEmail = `kody@${new URL(appBaseUrl).hostname}`
	return { appBaseUrl, fromEmail }
}

function buildEmailChangeEmail(input: {
	currentEmail: string
	newEmail: string
	verificationUrl: string
}) {
	const currentEmail = escapeHtml(input.currentEmail)
	const newEmail = escapeHtml(input.newEmail)
	const verificationUrl = escapeHtml(input.verificationUrl)
	return {
		subject: 'Verify your new kody email',
		text: [
			`We received a request to change your kody account email from ${input.currentEmail} to ${input.newEmail}.`,
			`Verify the new email address: ${input.verificationUrl}`,
			'If you did not request this change, you can safely ignore this email.',
		].join('\n\n'),
		html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Verify your new email</title>
  </head>
  <body>
    <p>We received a request to change your kody account email from ${currentEmail} to ${newEmail}.</p>
    <p><a href="${verificationUrl}">Verify the new email address</a></p>
    <p>If you did not request this change, you can safely ignore this email.</p>
  </body>
</html>`,
	}
}

export async function createEmailChangeVerification(input: {
	env: Env
	userId: number
	currentEmail: string
	newEmail: string
	requestUrl: string | URL
}) {
	const db = createDb(input.env.APP_DB)
	const token = generateEmailChangeToken()
	const tokenHash = await hashVerificationToken(token)
	const expiresAt = Date.now() + emailChangeTokenExpiryMs

	await input.env.APP_DB.prepare(
		`DELETE FROM pending_email_changes WHERE user_id = ?`,
	)
		.bind(input.userId)
		.run()

	await db.create(pendingEmailChangesTable, {
		user_id: input.userId,
		new_email: input.newEmail,
		token_hash: tokenHash,
		expires_at: expiresAt,
	})

	async function discardNewToken() {
		await input.env.APP_DB.prepare(
			`DELETE FROM pending_email_changes WHERE token_hash = ?`,
		)
			.bind(tokenHash)
			.run()
			.catch(() => undefined)
	}

	const emailConfig = getEmailChangeConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const verificationUrl = new URL(
		'/verify-email-change',
		emailConfig.appBaseUrl,
	)
	verificationUrl.searchParams.set('token', token)
	const email = buildEmailChangeEmail({
		currentEmail: input.currentEmail,
		newEmail: input.newEmail,
		verificationUrl: verificationUrl.toString(),
	})

	let sendResult: Awaited<ReturnType<typeof sendCloudflareEmail>>
	try {
		sendResult = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: input.newEmail,
				from: emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		)
	} catch (error) {
		await discardNewToken()
		throw error
	}
	if (!sendResult.ok) {
		if (!(sendResult.skipped && isNonProductionRuntime(input.env))) {
			await discardNewToken()
			throw new Error(sendResult.error ?? 'Email change could not be sent.')
		}
		console.warn('email-change-send-skipped', input.userId)
	}

	await input.env.APP_DB.prepare(
		`DELETE FROM pending_email_changes WHERE user_id = ? AND token_hash != ?`,
	)
		.bind(input.userId, tokenHash)
		.run()
		.catch((error) => {
			console.warn('email-change-token-cleanup-failed', error)
		})
}

export type VerifyEmailChangeResult =
	| { ok: true; userId: number; oldEmail: string; newEmail: string }
	| {
			ok: false
			reason:
				| 'missing_token'
				| 'invalid_token'
				| 'expired_token'
				| 'email_conflict'
	  }

export async function verifyEmailChangeToken(input: {
	db: D1Database
	token: unknown
	now?: Date
}): Promise<VerifyEmailChangeResult> {
	const token = typeof input.token === 'string' ? input.token.trim() : ''
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const record = await input.db
		.prepare(
			`SELECT pec.id, pec.user_id, pec.new_email, pec.expires_at, u.email, u.stable_user_id
			 FROM pending_email_changes pec
			 INNER JOIN users u ON u.id = pec.user_id
			 WHERE pec.token_hash = ?`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			new_email: string
			expires_at: number
			email: string
			stable_user_id: string
		}>()
	const now = input.now ?? new Date()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(`DELETE FROM pending_email_changes WHERE id = ?`)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}

	const newEmail = normalizeEmail(record.new_email)
	const existing = await input.db
		.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`)
		.bind(newEmail, record.user_id)
		.first<{ id: number }>()
	if (existing) return { ok: false, reason: 'email_conflict' }

	// Preserve the existing stable id across email changes so MCP identity,
	// ownership rows, and grants stay bound to the same account.
	const stableUserId = resolveUserStableId(record)
	const verifiedAt = now.toISOString()

	try {
		await input.db
			.prepare(
				`UPDATE users
				 SET email = ?,
				     email_verified_at = ?,
				     stable_user_id = ?,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`,
			)
			.bind(newEmail, verifiedAt, stableUserId, record.user_id)
			.run()
	} catch (error) {
		if (getUniqueConstraintField(error) === 'email') {
			return { ok: false, reason: 'email_conflict' }
		}
		throw error
	}

	await input.db
		.prepare(`DELETE FROM pending_email_changes WHERE user_id = ?`)
		.bind(record.user_id)
		.run()
	await input.db
		.prepare(`DELETE FROM email_verifications WHERE user_id = ?`)
		.bind(record.user_id)
		.run()

	return {
		ok: true,
		userId: record.user_id,
		oldEmail: record.email,
		newEmail,
	}
}
