import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { buildEmailDestinationVerificationEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import {
	addEmailNotificationDestination,
	deleteEmailNotificationDestinationRow,
	EmailDestinationError,
	markEmailNotificationDestinationVerified,
	type EmailNotificationDestination,
} from './destinations.ts'
import {
	generateVerificationToken,
	hashVerificationToken,
	verificationTokenExpiryMs,
} from '#worker/identity/email-verification-tokens.ts'

export const emailDestinationRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

function destinationVerificationRateLimitKey(userId: number) {
	return `email-destination:user:${userId}`
}

async function consumeDestinationVerificationRateLimit(
	db: D1Database,
	userId: number,
) {
	const rateLimit = await checkRateLimit(
		db,
		destinationVerificationRateLimitKey(userId),
		emailDestinationRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		throw new EmailDestinationError(
			'rate_limited',
			'Too many destination verification requests. Please try again later.',
		)
	}
}

async function refundDestinationVerificationRateLimit(
	db: D1Database,
	userId: number,
) {
	await releaseRateLimit(db, destinationVerificationRateLimitKey(userId)).catch(
		() => undefined,
	)
}

export type VerifyEmailDestinationResult =
	| {
			ok: true
			userId: number
			email: string
	  }
	| {
			ok: false
			reason: 'missing_token' | 'invalid_token' | 'expired_token'
	  }

function getDestinationEmailConfig(input: {
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

export function buildEmailDestinationVerificationUrl(input: {
	appBaseUrl: string
	token: string
}) {
	const verificationUrl = new URL('/verify-email-destination', input.appBaseUrl)
	verificationUrl.searchParams.set('token', input.token)
	return verificationUrl
}

async function insertDestinationVerificationToken(input: {
	db: D1Database
	userId: number
	destinationId: string
	now?: Date
}) {
	const token = generateVerificationToken()
	const tokenHash = await hashVerificationToken(token)
	const now = input.now ?? new Date()
	const expiresAt = now.getTime() + verificationTokenExpiryMs
	await input.db
		.prepare(
			`INSERT INTO pending_email_destination_verifications
			 (user_id, destination_id, token_hash, expires_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(input.userId, input.destinationId, tokenHash, expiresAt)
		.run()
	return { token, tokenHash }
}

async function discardDestinationVerificationToken(
	db: D1Database,
	tokenHash: string,
) {
	await db
		.prepare(
			`DELETE FROM pending_email_destination_verifications
			 WHERE token_hash = ?`,
		)
		.bind(tokenHash)
		.run()
		.catch(() => undefined)
}

async function sendDestinationVerificationEmail(input: {
	env: Env
	userId: number
	destinationId: string
	destinationEmail: string
	requestUrl: string | URL
	token: string
	tokenHash: string
	onSendFailure: () => Promise<void>
}) {
	const emailConfig = getDestinationEmailConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const verificationUrl = buildEmailDestinationVerificationUrl({
		appBaseUrl: emailConfig.appBaseUrl,
		token: input.token,
	})
	const email = buildEmailDestinationVerificationEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		destinationEmail: input.destinationEmail,
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
				to: input.destinationEmail,
				from: emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		)
	} catch (error) {
		await input.onSendFailure()
		throw error
	}
	if (!sendResult.ok) {
		if (!(sendResult.skipped && isNonProductionRuntime(input.env))) {
			await input.onSendFailure()
			throw new Error(
				sendResult.error ?? 'Destination verification could not be sent.',
			)
		}
		console.warn('email-destination-verify-send-skipped', input.userId)
	}

	await input.env.APP_DB.prepare(
		`DELETE FROM pending_email_destination_verifications
		 WHERE destination_id = ?
		   AND token_hash != ?
		   AND id < (
			 SELECT id FROM pending_email_destination_verifications
			 WHERE token_hash = ?
		   )`,
	)
		.bind(input.destinationId, input.tokenHash, input.tokenHash)
		.run()
		.catch((error) => {
			console.warn('email-destination-token-cleanup-failed', error)
		})
}

export async function createEmailDestinationVerification(input: {
	env: Env
	userId: number
	email: string
	requestUrl: string | URL
}): Promise<{ destination: EmailNotificationDestination; created: boolean }> {
	await consumeDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
	let added: {
		destination: EmailNotificationDestination
		created: boolean
	}
	try {
		added = await addEmailNotificationDestination({
			db: input.env.APP_DB,
			dbUserId: input.userId,
			email: input.email,
		})
	} catch (error) {
		await refundDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
		throw error
	}

	let minted: { token: string; tokenHash: string }
	try {
		minted = await insertDestinationVerificationToken({
			db: input.env.APP_DB,
			userId: input.userId,
			destinationId: added.destination.id,
		})
	} catch (error) {
		await refundDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
		throw error
	}

	try {
		await sendDestinationVerificationEmail({
			env: input.env,
			userId: input.userId,
			destinationId: added.destination.id,
			destinationEmail: added.destination.email,
			requestUrl: input.requestUrl,
			token: minted.token,
			tokenHash: minted.tokenHash,
			onSendFailure: async () => {
				await discardDestinationVerificationToken(
					input.env.APP_DB,
					minted.tokenHash,
				)
				if (added.created) {
					await deleteEmailNotificationDestinationRow({
						db: input.env.APP_DB,
						destinationId: added.destination.id,
						userId: input.userId,
					})
				}
			},
		})
	} catch (error) {
		await refundDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
		throw error
	}

	return added
}

export async function resendEmailDestinationVerification(input: {
	env: Env
	userId: number
	destinationId: string
	requestUrl: string | URL
}): Promise<EmailNotificationDestination> {
	await consumeDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
	const row = await input.env.APP_DB.prepare(
		`SELECT id, email, verified_at, is_default
		 FROM email_notification_destinations
		 WHERE id = ? AND user_id = ?`,
	)
		.bind(input.destinationId, input.userId)
		.first<{
			id: string
			email: string
			verified_at: string | null
			is_default: number
		}>()
	if (!row) {
		await refundDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
		throw new Error('Email destination was not found.')
	}
	if (row.verified_at) {
		await refundDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
		throw new Error('That address is already verified.')
	}

	try {
		const minted = await insertDestinationVerificationToken({
			db: input.env.APP_DB,
			userId: input.userId,
			destinationId: row.id,
		})

		await sendDestinationVerificationEmail({
			env: input.env,
			userId: input.userId,
			destinationId: row.id,
			destinationEmail: row.email,
			requestUrl: input.requestUrl,
			token: minted.token,
			tokenHash: minted.tokenHash,
			onSendFailure: async () => {
				await discardDestinationVerificationToken(
					input.env.APP_DB,
					minted.tokenHash,
				)
			},
		})
	} catch (error) {
		await refundDestinationVerificationRateLimit(input.env.APP_DB, input.userId)
		throw error
	}

	return {
		id: row.id,
		email: row.email,
		kind: 'additional',
		verified: false,
		isDefault: row.is_default === 1,
		canRemove: true,
	}
}

export async function verifyEmailDestinationToken(input: {
	db: D1Database
	token: unknown
	now?: Date
}): Promise<VerifyEmailDestinationResult> {
	const token = typeof input.token === 'string' ? input.token.trim() : ''
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const record = await input.db
		.prepare(
			`SELECT id, user_id, destination_id, expires_at
			 FROM pending_email_destination_verifications
			 WHERE token_hash = ?`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			destination_id: string
			expires_at: number
		}>()
	const now = input.now ?? new Date()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(
				`DELETE FROM pending_email_destination_verifications WHERE id = ?`,
			)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}

	const destination = await markEmailNotificationDestinationVerified({
		db: input.db,
		destinationId: record.destination_id,
		userId: record.user_id,
		now,
	})
	if (!destination) return { ok: false, reason: 'invalid_token' }

	return {
		ok: true,
		userId: record.user_id,
		email: destination.email,
	}
}
