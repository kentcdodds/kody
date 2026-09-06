import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { buildEmailClaimReleaseEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import {
	countRecentEmailClaimReleases,
	releaseAccountEmailClaim,
	resolveReleasableEmailClaim,
} from '#worker/identity/email-claims.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { toHex } from '@kody-internal/shared/hex.ts'

export const emailClaimReleaseRequestRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

export const emailClaimReleaseSuccessRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 24 * 60 * 60,
}

const emailClaimReleaseTokenBytes = 32
const emailClaimReleaseTokenExpiryMs = 24 * 60 * 60 * 1000

function generateEmailClaimReleaseToken() {
	const bytes = new Uint8Array(emailClaimReleaseTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

function getEmailClaimReleaseConfig(input: {
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

export async function createEmailClaimReleaseVerification(input: {
	env: Env
	userId: number
	stableUserId: string
	currentEmail: string
	email: string
	requestUrl: string | URL
}) {
	const email = normalizeEmail(input.email)
	const releasable = await resolveReleasableEmailClaim({
		db: input.env.APP_DB,
		userId: input.userId,
		stableUserId: input.stableUserId,
		currentEmail: input.currentEmail,
		email,
	})
	if (!releasable.ok) {
		throw new EmailClaimReleaseRequestError(releasable.reason)
	}

	const token = generateEmailClaimReleaseToken()
	const tokenHash = await hashVerificationToken(token)
	const expiresAt = Date.now() + emailClaimReleaseTokenExpiryMs

	await input.env.APP_DB.prepare(
		`DELETE FROM pending_email_claim_releases WHERE user_id = ? AND email = ?`,
	)
		.bind(input.userId, email)
		.run()

	await input.env.APP_DB.prepare(
		`INSERT INTO pending_email_claim_releases (user_id, email, token_hash, expires_at)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind(input.userId, email, tokenHash, expiresAt)
		.run()

	async function discardNewToken() {
		await input.env.APP_DB.prepare(
			`DELETE FROM pending_email_claim_releases WHERE token_hash = ?`,
		)
			.bind(tokenHash)
			.run()
			.catch(() => undefined)
	}

	const emailConfig = getEmailClaimReleaseConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const verificationUrl = new URL(
		'/verify-email-claim-release',
		emailConfig.appBaseUrl,
	)
	verificationUrl.searchParams.set('token', token)
	const message = buildEmailClaimReleaseEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		email,
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
				to: email,
				from: emailConfig.fromEmail,
				subject: message.subject,
				html: message.html,
				text: message.text,
			},
		)
	} catch (error) {
		await discardNewToken()
		throw error
	}
	if (!sendResult.ok) {
		if (!(sendResult.skipped && isNonProductionRuntime(input.env))) {
			await discardNewToken()
			throw new Error(sendResult.error ?? 'Release email could not be sent.')
		}
		console.warn('email-claim-release-send-skipped', input.userId)
	}
}

export type VerifyEmailClaimReleaseResult =
	| {
			ok: true
			userId: number
			email: string
	  }
	| {
			ok: false
			reason:
				| 'missing_token'
				| 'invalid_token'
				| 'expired_token'
				| 'not_claimed'
				| 'current_email'
				| 'daily_cap'
	  }

export async function verifyEmailClaimReleaseToken(input: {
	db: D1Database
	token: unknown
	now?: Date
}): Promise<VerifyEmailClaimReleaseResult> {
	const token = typeof input.token === 'string' ? input.token.trim() : ''
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const record = await input.db
		.prepare(
			`SELECT pec.id, pec.user_id, pec.email, pec.expires_at,
			        u.email AS current_email, u.stable_user_id
			 FROM pending_email_claim_releases pec
			 INNER JOIN users u ON u.id = pec.user_id
			 WHERE pec.token_hash = ?`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			email: string
			expires_at: number
			current_email: string
			stable_user_id: string
		}>()
	const now = input.now ?? new Date()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(`DELETE FROM pending_email_claim_releases WHERE id = ?`)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}

	const releasable = await resolveReleasableEmailClaim({
		db: input.db,
		userId: record.user_id,
		stableUserId: record.stable_user_id,
		currentEmail: record.current_email,
		email: record.email,
	})
	if (!releasable.ok) {
		await input.db
			.prepare(`DELETE FROM pending_email_claim_releases WHERE id = ?`)
			.bind(record.id)
			.run()
		return {
			ok: false,
			reason:
				releasable.reason === 'already_released'
					? 'not_claimed'
					: releasable.reason,
		}
	}

	const recentReleases = await countRecentEmailClaimReleases(input.db, {
		userId: record.user_id,
		windowSeconds: emailClaimReleaseSuccessRateLimitConfig.windowSeconds,
		now,
	})
	if (recentReleases >= emailClaimReleaseSuccessRateLimitConfig.maxRequests) {
		return { ok: false, reason: 'daily_cap' }
	}

	await releaseAccountEmailClaim(input.db, {
		userId: record.user_id,
		email: releasable.email,
		now,
	})
	await input.db
		.prepare(
			`DELETE FROM pending_email_claim_releases WHERE user_id = ? AND email = ?`,
		)
		.bind(record.user_id, releasable.email)
		.run()

	return {
		ok: true,
		userId: record.user_id,
		email: releasable.email,
	}
}

export class EmailClaimReleaseRequestError extends Error {
	readonly reason: 'current_email' | 'not_claimed' | 'already_released'

	constructor(reason: 'current_email' | 'not_claimed' | 'already_released') {
		super(`Email claim cannot be released (${reason}).`)
		this.name = 'EmailClaimReleaseRequestError'
		this.reason = reason
	}
}
