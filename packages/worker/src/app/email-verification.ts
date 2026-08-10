import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { createDb, emailVerificationsTable } from '#worker/db.ts'
import { toHex } from '@kody-internal/shared/hex.ts'

/**
 * The read-only verification check moved to
 * `#worker/identity/email-verification-state.ts` so callers outside the app
 * layer do not pull in the token-minting pipeline. Re-exported for app-layer
 * callers that read it alongside the token helpers below.
 */
export {
	assertAccountEmailVerified,
	emailVerificationRequiredMessage,
	isAccountEmailVerified,
} from '#worker/identity/email-verification-state.ts'

const verificationTokenBytes = 32
const verificationTokenExpiryMs = 24 * 60 * 60 * 1000

function generateVerificationToken() {
	const bytes = new Uint8Array(verificationTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

export async function hashVerificationToken(token: string) {
	const data = new TextEncoder().encode(token)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(digest))
}

function getVerificationEmailConfig(input: {
	env: Pick<Env, 'APP_BASE_URL'>
	requestUrl: string | URL
}) {
	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	const appBaseUrl = new URL(configuredBaseUrl || input.requestUrl).origin
	const fromEmail = `kody@${new URL(appBaseUrl).hostname}`
	return { appBaseUrl, fromEmail }
}

function buildVerificationEmail(verificationUrl: string) {
	return {
		subject: 'Verify your kody email',
		text: [
			'Welcome to kody.',
			`Verify your email address: ${verificationUrl}`,
			'If you did not create this account, you can safely ignore this email.',
		].join('\n\n'),
		html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Verify your email</title>
  </head>
  <body>
    <p>Welcome to kody.</p>
    <p><a href="${verificationUrl}">Verify your email address</a></p>
    <p>If you did not create this account, you can safely ignore this email.</p>
  </body>
</html>`,
	}
}

/** Builds `/verify-email` with token and an optional safe post-verify resume target. */
export function buildEmailVerificationUrl(input: {
	appBaseUrl: string
	token: string
	redirectTo?: string | null
}) {
	const verificationUrl = new URL('/verify-email', input.appBaseUrl)
	verificationUrl.searchParams.set('token', input.token)
	const safeRedirectTo = normalizeRedirectTo(input.redirectTo)
	if (safeRedirectTo) {
		verificationUrl.searchParams.set('redirectTo', safeRedirectTo)
	}
	return verificationUrl
}

export async function createEmailVerification(input: {
	env: Env
	userId: number
	email: string
	requestUrl: string | URL
	redirectTo?: string | null
}) {
	const db = createDb(input.env.APP_DB)
	const token = generateVerificationToken()
	const tokenHash = await hashVerificationToken(token)
	const expiresAt = Date.now() + verificationTokenExpiryMs

	// Insert the replacement token before sending so the link works the
	// moment the email lands, but keep prior tokens valid until the send
	// succeeds — a failed resend must not invalidate a link the user
	// already received.
	await db.create(emailVerificationsTable, {
		user_id: input.userId,
		token_hash: tokenHash,
		expires_at: expiresAt,
	})
	async function discardNewToken() {
		await input.env.APP_DB.prepare(
			`DELETE FROM email_verifications WHERE token_hash = ?`,
		)
			.bind(tokenHash)
			.run()
			.catch(() => undefined)
	}

	const emailConfig = getVerificationEmailConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const verificationUrl = buildEmailVerificationUrl({
		appBaseUrl: emailConfig.appBaseUrl,
		token,
		redirectTo: input.redirectTo,
	})
	const email = buildVerificationEmail(verificationUrl.toString())

	let sendResult: Awaited<ReturnType<typeof sendCloudflareEmail>>
	try {
		sendResult = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: input.email,
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
		// Local dev, preview, and test runtimes may have no email sender
		// configured; those accounts are verified through seeded tokens
		// instead. Anywhere else an unsent verification email would strand
		// the account with no way to verify, so fail hard and let callers
		// roll back.
		if (!(sendResult.skipped && isNonProductionRuntime(input.env))) {
			await discardNewToken()
			throw new Error(
				sendResult.error ?? 'Verification email could not be sent.',
			)
		}
		// This branch only exists for non-production runtimes (checked above),
		// so an operator warning would be noise; keep it informational.
		console.info('email-verification-send-skipped', input.userId)
	}

	// The new token is delivered (or the send was deliberately skipped in a
	// non-production runtime); retire older outstanding tokens. Best-effort
	// only: the email is already out, so a cleanup failure must not bubble
	// up and make callers (signup rollback) treat the send as failed —
	// stale tokens expire on their own and are purged when any token
	// verifies.
	await input.env.APP_DB.prepare(
		`DELETE FROM email_verifications WHERE user_id = ? AND token_hash != ?`,
	)
		.bind(input.userId, tokenHash)
		.run()
		.catch((error) => {
			console.warn('email-verification-token-cleanup-failed', error)
		})
}

export type VerifyEmailResult =
	| { ok: true; userId: number; email: string }
	| { ok: false; reason: 'missing_token' | 'invalid_token' | 'expired_token' }

export async function verifyEmailToken(input: {
	db: D1Database
	token: unknown
	now?: Date
}): Promise<VerifyEmailResult> {
	const token = typeof input.token === 'string' ? input.token.trim() : ''
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const record = await input.db
		.prepare(
			`SELECT ev.id, ev.user_id, ev.expires_at, u.email
			 FROM email_verifications ev
			 INNER JOIN users u ON u.id = ev.user_id
			 WHERE ev.token_hash = ?`,
		)
		.bind(tokenHash)
		.first<{ id: number; user_id: number; expires_at: number; email: string }>()
	const now = input.now ?? new Date()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(`DELETE FROM email_verifications WHERE id = ?`)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}

	const verifiedAt = now.toISOString()
	await input.db
		.prepare(
			`UPDATE users
			 SET email_verified_at = COALESCE(email_verified_at, ?),
			     updated_at = CURRENT_TIMESTAMP
			 WHERE id = ?`,
		)
		.bind(verifiedAt, record.user_id)
		.run()
	await input.db
		.prepare(`DELETE FROM email_verifications WHERE user_id = ?`)
		.bind(record.user_id)
		.run()

	return { ok: true, userId: record.user_id, email: record.email }
}
