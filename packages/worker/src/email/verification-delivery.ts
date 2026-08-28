import {
	isEmailVerificationDeliveryStatus,
	isEmailVerificationResendBlocked,
	parseEmailVerificationDelivery,
	type EmailVerificationDelivery,
	type EmailVerificationDeliveryClass,
	type EmailVerificationDeliveryStatus,
} from '#universal/email-verification-delivery.ts'
import { type EmailDeliveryStatus } from './types.ts'

export const transactionalEmailVerificationKind = 'email_verification'

const deliveryDetailMaxLength = 500

const senderBlockPattern =
	/\brlr613\b|\brlr813\b|blacklisted|blacklist|blocked.*sender|sender.*blocked|sender domain|blocked by policy|rejected by policy/

export class EmailVerificationSendBlockedError extends Error {
	readonly code = 'sender_block'

	constructor(message?: string) {
		super(
			message ??
				'Verification email cannot be resent because the mailbox provider blocked kody.codes.',
		)
		this.name = 'EmailVerificationSendBlockedError'
	}
}

export function classifyVerificationDeliveryFailure(input: {
	status: EmailDeliveryStatus | EmailVerificationDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
}): EmailVerificationDeliveryClass | null {
	if (
		input.status !== 'bounced' &&
		input.status !== 'failed' &&
		input.status !== 'rejected' &&
		input.status !== 'complained'
	) {
		return null
	}
	const haystack = [
		input.smtpResponse ?? '',
		input.smtpEnhancedStatusCode ?? '',
	]
		.join(' ')
		.toLowerCase()
	if (senderBlockPattern.test(haystack)) return 'sender_block'
	return 'other'
}

function truncateDeliveryDetail(value: string | null | undefined) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	return trimmed.length > deliveryDetailMaxLength
		? trimmed.slice(0, deliveryDetailMaxLength)
		: trimmed
}

export async function registerTransactionalEmailDelivery(input: {
	db: D1Database
	providerMessageId: string
	userId: number
	recipient: string
	kind?: string
}) {
	await input.db
		.prepare(
			`INSERT OR REPLACE INTO transactional_email_delivery_index
			 (provider_message_id, user_id, kind, recipient)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(
			input.providerMessageId,
			input.userId,
			input.kind ?? transactionalEmailVerificationKind,
			input.recipient,
		)
		.run()
}

export async function lookupTransactionalEmailDelivery(input: {
	db: D1Database
	providerMessageId: string
}) {
	return await input.db
		.prepare(
			`SELECT provider_message_id, user_id, kind, recipient
			 FROM transactional_email_delivery_index
			 WHERE provider_message_id = ?`,
		)
		.bind(input.providerMessageId)
		.first<{
			provider_message_id: string
			user_id: number
			kind: string
			recipient: string
		}>()
}

export async function loadUserEmailVerificationDelivery(
	db: D1Database,
	userId: number,
): Promise<EmailVerificationDelivery | null> {
	const row = await db
		.prepare(
			`SELECT email_verification_delivery_status, email_verification_delivery_class, email_verification_delivery_at
			 FROM users
			 WHERE id = ?`,
		)
		.bind(userId)
		.first<{
			email_verification_delivery_status: string | null
			email_verification_delivery_class: string | null
			email_verification_delivery_at: string | null
		}>()
	if (!row) return null
	return parseEmailVerificationDelivery({
		status: row.email_verification_delivery_status,
		class: row.email_verification_delivery_class,
		at: row.email_verification_delivery_at,
	})
}

export async function setUserEmailVerificationDelivery(input: {
	db: D1Database
	userId: number
	status: EmailVerificationDeliveryStatus
	class?: EmailVerificationDeliveryClass | null
	at?: string | Date
	detail?: string | null
}) {
	const at =
		input.at instanceof Date
			? input.at.toISOString()
			: (input.at ?? new Date().toISOString())
	await input.db
		.prepare(
			`UPDATE users
			 SET email_verification_delivery_status = ?,
			     email_verification_delivery_at = ?,
			     email_verification_delivery_detail = ?,
			     email_verification_delivery_class = ?,
			     updated_at = ?
			 WHERE id = ?`,
		)
		.bind(
			input.status,
			at,
			truncateDeliveryDetail(input.detail),
			input.class ?? null,
			at,
			input.userId,
		)
		.run()
}

export async function clearUserEmailVerificationDelivery(
	db: D1Database,
	userId: number,
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`UPDATE users
			 SET email_verification_delivery_status = NULL,
			     email_verification_delivery_at = NULL,
			     email_verification_delivery_detail = NULL,
			     email_verification_delivery_class = NULL,
			     updated_at = ?
			 WHERE id = ?`,
		)
		.bind(now, userId)
		.run()
}

export async function assertVerificationResendAllowed(
	db: D1Database,
	userId: number,
) {
	const delivery = await loadUserEmailVerificationDelivery(db, userId)
	if (isEmailVerificationResendBlocked(delivery)) {
		throw new EmailVerificationSendBlockedError()
	}
}

const terminalFailureStatuses = new Set<EmailVerificationDeliveryStatus>([
	'bounced',
	'failed',
	'rejected',
	'complained',
])

export type RecordedTransactionalDelivery = {
	userId: number
	kind: string
	recipient: string
	status: EmailVerificationDeliveryStatus
	class: EmailVerificationDeliveryClass | null
	alreadyTerminal: boolean
}

export async function recordTransactionalEmailDeliveryEvent(input: {
	db: D1Database
	providerMessageId: string
	deliveryStatus: EmailDeliveryStatus
	eventTimestamp: string
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
}): Promise<
	| { outcome: 'unmatched' }
	| { outcome: 'recorded'; event: RecordedTransactionalDelivery }
> {
	const index = await lookupTransactionalEmailDelivery({
		db: input.db,
		providerMessageId: input.providerMessageId,
	})
	if (!index || index.kind !== transactionalEmailVerificationKind) {
		return { outcome: 'unmatched' }
	}
	if (!isEmailVerificationDeliveryStatus(input.deliveryStatus)) {
		return { outcome: 'unmatched' }
	}

	const existing = await loadUserEmailVerificationDelivery(
		input.db,
		index.user_id,
	)
	const alreadyTerminal = Boolean(
		existing && terminalFailureStatuses.has(existing.status),
	)
	const classified = classifyVerificationDeliveryFailure({
		status: input.deliveryStatus,
		smtpResponse: input.smtpResponse,
		smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
	})
	const deliveryClass =
		existing?.class === 'sender_block' && input.deliveryStatus !== 'delivered'
			? 'sender_block'
			: classified
	await setUserEmailVerificationDelivery({
		db: input.db,
		userId: index.user_id,
		status: input.deliveryStatus,
		class: deliveryClass,
		at: input.eventTimestamp,
		detail: input.smtpResponse ?? input.smtpEnhancedStatusCode ?? null,
	})
	return {
		outcome: 'recorded',
		event: {
			userId: index.user_id,
			kind: index.kind,
			recipient: index.recipient,
			status: input.deliveryStatus,
			class: deliveryClass,
			alreadyTerminal,
		},
	}
}
