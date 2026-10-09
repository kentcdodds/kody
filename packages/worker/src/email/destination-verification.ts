import * as Sentry from '@sentry/cloudflare'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { buildEmailDestinationVerificationEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import {
	generateVerificationToken,
	hashVerificationToken,
	verificationTokenExpiryMs,
} from '#worker/identity/email-verification-tokens.ts'
import {
	addEmailNotificationDestination,
	deleteEmailNotificationDestinationRow,
	EmailDestinationError,
	loadEmailDestinationAccount,
	markEmailNotificationDestinationVerified,
	type EmailNotificationDestination,
} from './destinations.ts'
import { resolveUserPlatformSender } from './platform-address.ts'
import {
	CloudflareEmailProviderSkippedError,
	sendViaCloudflareEmailProvider,
} from './provider-send.ts'
import {
	registerTransactionalEmailDelivery,
	transactionalEmailDestinationVerificationKind,
} from './verification-delivery.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
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

export type VerifyEmailDestinationReason =
	| 'missing_token'
	| 'invalid_token'
	| 'expired_token'

export type VerifyEmailDestinationResult =
	| {
			ok: true
			userId: number
			email: string
	  }
	| {
			ok: false
			reason: VerifyEmailDestinationReason
	  }

function readDestinationVerificationToken(token: unknown) {
	if (typeof token !== 'string') return ''
	return token.trim().toLowerCase()
}

function getDestinationLinkConfig(input: {
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

function captureDestinationVerificationSendFailure(input: {
	error: unknown
	userId: number
	destinationEmail: string
	from: string
}) {
	Sentry.captureException(input.error, {
		tags: {
			email_flow: 'destination_verification',
		},
		extra: {
			userId: input.userId,
			destinationEmail: input.destinationEmail,
			from: input.from,
		},
	})
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
	const account = await loadEmailDestinationAccount({
		db: input.env.APP_DB,
		dbUserId: input.userId,
	})
	if (!account) {
		throw new Error('Account was not found for destination verification.')
	}

	const linkConfig = getDestinationLinkConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const sender = await resolveUserPlatformSender({
		db: input.env.APP_DB,
		env: input.env,
		accountEmail: account.email,
		userId: account.stableUserId,
	})
	const verificationUrl = buildEmailDestinationVerificationUrl({
		appBaseUrl: linkConfig.appBaseUrl,
		token: input.token,
	})
	const email = buildEmailDestinationVerificationEmail({
		appBaseUrl: linkConfig.appBaseUrl,
		destinationEmail: input.destinationEmail,
		verificationUrl: verificationUrl.toString(),
	})

	let messageId: string | null = null
	try {
		const sendResult = await sendViaCloudflareEmailProvider({
			env: input.env,
			from: sender.from,
			to: [input.destinationEmail],
			subject: email.subject,
			html: email.html,
			text: email.text,
		})
		messageId = sendResult.messageId
	} catch (error) {
		if (
			error instanceof CloudflareEmailProviderSkippedError &&
			isNonProductionRuntime(input.env)
		) {
			console.warn('email-destination-verify-send-skipped', input.userId)
		} else {
			await input.onSendFailure()
			captureDestinationVerificationSendFailure({
				error,
				userId: input.userId,
				destinationEmail: input.destinationEmail,
				from: sender.from,
			})
			throw error instanceof Error
				? error
				: new Error('Destination verification could not be sent.')
		}
	}

	if (messageId) {
		await registerTransactionalEmailDelivery({
			db: input.env.APP_DB,
			providerMessageId: messageId,
			userId: input.userId,
			recipient: input.destinationEmail,
			kind: transactionalEmailDestinationVerificationKind,
		}).catch((error) => {
			console.warn(
				'email-destination-verification-delivery-index-failed',
				error,
			)
		})
	}
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
		 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
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

async function retireSiblingDestinationVerificationTokens(
	db: D1Database,
	destinationId: string,
	tokenHash: string,
) {
	await db
		.prepare(
			`DELETE FROM pending_email_destination_verifications
			 WHERE destination_id = ? AND token_hash != ?`,
		)
		.bind(destinationId, tokenHash)
		.run()
		.catch((error) => {
			console.warn('email-destination-token-cleanup-failed', error)
		})
}

export async function verifyEmailDestinationToken(input: {
	db: D1Database
	token: unknown
	now?: Date
	/** When false, a valid unused token is not consumed. HEAD probes use this. */
	consume?: boolean
}): Promise<VerifyEmailDestinationResult> {
	const token = readDestinationVerificationToken(input.token)
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const record = await input.db
		.prepare(
			`SELECT p.id, p.user_id, p.destination_id, p.expires_at, d.email
			 FROM pending_email_destination_verifications p
			 LEFT JOIN email_notification_destinations d ON d.id = p.destination_id
			 WHERE p.token_hash = ?${andLiveDeletedAtSql()}`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			destination_id: string
			expires_at: number
			email: string | null
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
	if (!record.email) {
		await input.db
			.prepare(
				`DELETE FROM pending_email_destination_verifications WHERE id = ?`,
			)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'invalid_token' }
	}

	if (input.consume === false) {
		return {
			ok: true,
			userId: record.user_id,
			email: record.email,
		}
	}

	const destination = await markEmailNotificationDestinationVerified({
		db: input.db,
		destinationId: record.destination_id,
		userId: record.user_id,
		now,
	})
	if (!destination) return { ok: false, reason: 'invalid_token' }

	await retireSiblingDestinationVerificationTokens(
		input.db,
		record.destination_id,
		tokenHash,
	)

	return {
		ok: true,
		userId: record.user_id,
		email: destination.email,
	}
}
