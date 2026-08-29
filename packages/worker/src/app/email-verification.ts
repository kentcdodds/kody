import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { buildVerificationEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import {
	clearUserEmailVerificationDelivery,
	registerTransactionalEmailDelivery,
	setUserEmailVerificationDelivery,
} from '#worker/email/verification-delivery.ts'
import {
	buildEmailVerificationUrl,
	discardEmailVerificationToken,
	hashVerificationToken,
	insertEmailVerificationToken,
	retireOtherEmailVerificationTokens,
} from '#worker/identity/email-verification-tokens.ts'

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

export { buildEmailVerificationUrl, hashVerificationToken }

function getVerificationEmailConfig(input: {
	env: Pick<Env, 'APP_BASE_URL' | 'SYSTEM_EMAIL_DOMAIN'> & {
		WRANGLER_IS_LOCAL_DEV?: string
	}
	requestUrl: string | URL
}) {
	return (
		resolveTransactionalEmailConfig({
			env: input.env,
			requestUrl: input.requestUrl,
		}) ?? {
			appBaseUrl: new URL(input.requestUrl).origin,
			fromEmail: `kody@${new URL(input.requestUrl).hostname}`,
		}
	)
}

export async function createEmailVerification(input: {
	env: Env
	userId: number
	email: string
	requestUrl: string | URL
	redirectTo?: string | null
}) {
	const minted = await insertEmailVerificationToken({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	async function discardNewToken() {
		await discardEmailVerificationToken(input.env.APP_DB, minted.tokenHash)
	}

	const emailConfig = getVerificationEmailConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const verificationUrl = buildEmailVerificationUrl({
		appBaseUrl: emailConfig.appBaseUrl,
		token: minted.token,
		redirectTo: input.redirectTo,
	})
	const email = buildVerificationEmail({
		appBaseUrl: emailConfig.appBaseUrl,
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

	if (sendResult.ok && sendResult.messageId) {
		await registerTransactionalEmailDelivery({
			db: input.env.APP_DB,
			providerMessageId: sendResult.messageId,
			userId: input.userId,
			recipient: input.email,
		}).catch((error) => {
			console.warn('email-verification-delivery-index-failed', error)
		})
	}
	if (sendResult.ok || sendResult.skipped) {
		await setUserEmailVerificationDelivery({
			db: input.env.APP_DB,
			userId: input.userId,
			status: 'accepted',
			class: null,
			detail: null,
		}).catch((error) => {
			console.warn('email-verification-delivery-status-failed', error)
		})
	}

	// The new token is delivered (or the send was deliberately skipped in a
	// non-production runtime); retire older outstanding tokens. Best-effort
	// only: the email is already out, so a cleanup failure must not bubble
	// up and make callers (signup rollback) treat the send as failed —
	// stale tokens expire on their own and are purged when any token
	// verifies.
	await retireOtherEmailVerificationTokens(
		input.env.APP_DB,
		input.userId,
		minted.tokenHash,
	)
}

export type VerifyEmailResult =
	| {
			ok: true
			userId: number
			email: string
			stableUserId: string
			newlyVerified: boolean
	  }
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
			`SELECT ev.id, ev.user_id, ev.expires_at, u.email,
			        u.stable_user_id, u.email_verified_at
			 FROM email_verifications ev
			 INNER JOIN users u ON u.id = ev.user_id
			 WHERE ev.token_hash = ?`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			expires_at: number
			email: string
			stable_user_id: string
			email_verified_at: string | null
		}>()
	const now = input.now ?? new Date()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(`DELETE FROM email_verifications WHERE id = ?`)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}

	const newlyVerified = !record.email_verified_at
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
	await clearUserEmailVerificationDelivery(input.db, record.user_id).catch(
		() => undefined,
	)
	await input.db
		.prepare(`DELETE FROM email_verifications WHERE user_id = ?`)
		.bind(record.user_id)
		.run()

	return {
		ok: true,
		userId: record.user_id,
		email: record.email,
		stableUserId: record.stable_user_id,
		newlyVerified,
	}
}
