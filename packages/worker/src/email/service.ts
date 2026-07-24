import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { isoTimestampDayKey } from '@kody-internal/shared/date-keys.ts'
import PostalMime from 'postal-mime'
import { withAccountWriteLease } from '#app/account-deletion-state.ts'
import {
	getInboundDelivery,
	markInboundDeliveryReceived,
	type InboundDelivery,
} from './inbound-delivery.ts'
import {
	createEmailThread,
	deleteEmailMessageById,
	emailRawMimeKey,
	findEmailThreadForInboundMessage,
	getEmailAttachmentRecordById,
	getEmailMessageById,
	getOutboundEmailMessageByProviderMessageId,
	insertEmailAttachments,
	insertEmailDeliveryEvent,
	insertEmailMessage,
	listEmailAttachmentsForMessage,
	touchEmailThread,
} from './repo.ts'
import {
	type EmailDeliveryEventRecord,
	type EmailDeliveryStatus,
	type EmailMessageRecord,
	type ParsedInboundEmail,
} from './types.ts'

export {
	createEmailThread,
	emailAttachmentBlobKey,
	emailRawMimeKey,
	ensurePlatformSenderIdentity,
	findEmailThreadForInboundMessage,
	getEmailMessageById,
	getEmailMessageByMessageIdHeader,
	insertEmailAttachments,
	insertEmailDeliveryEvent,
	touchEmailThread,
	updateEmailMessageDelivery,
} from './repo.ts'

function nowIso() {
	return new Date().toISOString()
}

/**
 * Retryable inbound storage failure. Stable delivery/message/blob identifiers
 * make another Email Routing attempt repair the same logical delivery without
 * consuming quota or inserting another message.
 */
export class RetryableInboundStorageError extends Error {
	override name = 'RetryableInboundStorageError'
	constructor(message: string, cause?: unknown) {
		super(message, { cause })
	}
}

/**
 * Retryable EMAIL_BLOBS put failure for inbound raw MIME (pre-commit).
 * The inbound email handler lets this propagate so Cloudflare Email Routing
 * treats delivery as a temporary failure (throw) rather than a permanent
 * `setReject`.
 */
export class EmailRawMimeStorageError extends RetryableInboundStorageError {
	override name = 'EmailRawMimeStorageError'
	constructor(messageId: string, cause?: unknown) {
		super(
			`Failed to store email raw MIME in EMAIL_BLOBS (message ${messageId}); delivery should be retried.`,
			cause,
		)
	}
}

/**
 * Persist inbound raw MIME to EMAIL_BLOBS before the D1 insert. Returns the
 * object key on success. Throws EmailRawMimeStorageError on put failure.
 */
async function putRawMimeToBlobs(input: {
	blobs: R2Bucket
	userId: string
	messageId: string
	rawMime: string
}): Promise<string> {
	const key = emailRawMimeKey(input.userId, input.messageId)
	try {
		await input.blobs.put(key, input.rawMime)
		return key
	} catch (error) {
		throw new EmailRawMimeStorageError(input.messageId, error)
	}
}

/**
 * Resolve a message's raw MIME from EMAIL_BLOBS via `raw_mime_key`.
 * Returns null when the message has no key or the blob is unreachable.
 */
export async function loadRawMime(input: {
	blobs: R2Bucket
	message: Pick<EmailMessageRecord, 'rawMimeKey'>
}): Promise<string | null> {
	const key = input.message.rawMimeKey
	if (!key) return null
	const object = await input.blobs.get(key)
	if (!object) return null
	return await object.text()
}

type InsertEmailMessageInput = Parameters<typeof insertEmailMessage>[0]
type InsertEmailMessageWithoutRawMimeInput = Omit<
	InsertEmailMessageInput,
	'message'
> & {
	message: Omit<InsertEmailMessageInput['message'], 'rawMimeKey'>
}
type InsertEmailMessageWithRawMimeInput = Omit<
	InsertEmailMessageInput,
	'message'
> & {
	blobs: R2Bucket
	message: Omit<InsertEmailMessageInput['message'], 'rawMimeKey'> & {
		rawMime?: string | null
	}
}

/**
 * Domain insert for messages that must not point at EMAIL_BLOBS raw MIME.
 * Forces `rawMimeKey: null` so callers cannot invent a key without a blob.
 * Inbound mail with raw MIME must use `insertEmailMessageWithRawMime`.
 */
export async function insertEmailMessageWithoutRawMime(
	input: InsertEmailMessageWithoutRawMimeInput,
) {
	return await insertEmailMessage({
		db: input.db,
		message: {
			...input.message,
			rawMimeKey: null,
		},
	})
}

export async function insertEmailMessageWithRawMime(
	input: InsertEmailMessageWithRawMimeInput,
) {
	const { blobs, db, message } = input
	const { rawMime, ...messageInput } = message
	const write = async () => {
		const messageId = messageInput.id ?? crypto.randomUUID()
		let rawMimeKey: string | null = null
		if (rawMime != null) {
			rawMimeKey = await putRawMimeToBlobs({
				blobs,
				userId: messageInput.userId,
				messageId,
				rawMime,
			})
		}
		try {
			return await insertEmailMessage({
				db,
				message: {
					...messageInput,
					id: messageId,
					rawMimeKey,
				},
			})
		} catch (error) {
			if (rawMimeKey != null) {
				await blobs.delete(rawMimeKey).catch(() => undefined)
			}
			throw error
		}
	}
	return messageInput.userId === 'system:email'
		? await write()
		: await withAccountWriteLease({
				db,
				stableUserId: messageInput.userId,
				write,
			})
}

export async function getEmailMessageWithAttachmentsById(input: {
	db: D1Database
	userId: string
	messageId: string
}) {
	const message = await getEmailMessageById(input)
	if (!message) return null
	const attachments = await listEmailAttachmentsForMessage({
		db: input.db,
		messageId: message.id,
	})
	return {
		message,
		attachments,
	}
}

export async function insertEmailMessageWithAttachments(
	input: InsertEmailMessageWithRawMimeInput & {
		attachments: Parameters<typeof insertEmailAttachments>[0]['attachments']
	},
) {
	let message
	try {
		message = await insertEmailMessageWithRawMime(input)
	} catch (error) {
		if (error instanceof RetryableInboundStorageError) throw error
		throw new RetryableInboundStorageError(
			'Failed to store inbound email message; delivery should be retried.',
			error,
		)
	}
	if (input.attachments.length === 0) return message
	try {
		await insertEmailAttachments({
			db: input.db,
			messageId: message.id,
			attachments: input.attachments,
		})
		return message
	} catch (attachmentError) {
		let cleanupError: unknown
		try {
			await deleteEmailMessageById({
				db: input.db,
				blobs: input.blobs,
				messageId: message.id,
			})
		} catch (error) {
			cleanupError = error
		}
		let remaining: Awaited<ReturnType<typeof getEmailMessageById>>
		try {
			remaining = await getEmailMessageById({
				db: input.db,
				userId: message.userId,
				messageId: message.id,
			})
		} catch (probeError) {
			// Probe failed: commit state is ambiguous. Do not retry/refund —
			// that risks duplicates if the row is still durable.
			console.error(
				'inbound-email-attachment-cleanup-probe-failed',
				message.id,
				attachmentError,
				cleanupError,
				probeError,
			)
			return message
		}
		if (remaining) {
			// Message row is durable; retrying would duplicate mail. Acknowledge
			// the commit and leave operators the cleanup/attachment failure logs.
			console.error(
				'inbound-email-attachment-cleanup-failed',
				message.id,
				attachmentError,
				cleanupError,
			)
			return remaining
		}
		throw new RetryableInboundStorageError(
			'Failed to store inbound email attachments; message cleaned up and delivery should be retried.',
			attachmentError,
		)
	}
}

export async function storeIdempotentInboundEmail(input: {
	db: D1Database
	blobs: R2Bucket
	delivery: InboundDelivery
	parsed: ParsedInboundEmail
	subjectNormalized: string
	now: string
}) {
	const { delivery, parsed } = input
	if (!delivery.storageLease) {
		throw new RetryableInboundStorageError(
			'Inbound delivery storage requires an active lease.',
		)
	}
	const inboundDeliveryFence = {
		deliveryId: delivery.deliveryId,
		userId: delivery.userId,
		storageLease: delivery.storageLease,
	}
	await putRawMimeToBlobs({
		blobs: input.blobs,
		userId: delivery.userId,
		messageId: delivery.messageId,
		rawMime: parsed.rawMime,
	})

	let stored = await getEmailMessageById({
		db: input.db,
		userId: delivery.userId,
		messageId: delivery.messageId,
	})
	if (!stored) {
		let thread = await findEmailThreadForInboundMessage({
			db: input.db,
			userId: delivery.userId,
			inboxId: delivery.inboxId,
			references: parsed.references,
			inReplyToHeader: parsed.inReplyTo,
		})
		if (!thread) {
			thread = await createEmailThread({
				db: input.db,
				id: delivery.threadId,
				userId: delivery.userId,
				inboxId: delivery.inboxId,
				subjectNormalized: input.subjectNormalized,
				rootMessageIdHeader: parsed.messageId,
				lastMessageAt: input.now,
				ignoreConflict: true,
				inboundDeliveryFence,
			})
		}
		try {
			stored = await insertEmailMessage({
				db: input.db,
				inboundDeliveryFence,
				message: {
					id: delivery.messageId,
					direction: 'inbound',
					userId: delivery.userId,
					inboxId: delivery.inboxId,
					threadId: thread.id,
					senderIdentityId: null,
					fromAddress: parsed.headerFrom,
					envelopeFrom: parsed.envelopeFrom,
					toAddresses: parsed.to.map((entry) => entry.address),
					ccAddresses: parsed.cc.map((entry) => entry.address),
					bccAddresses: parsed.bcc.map((entry) => entry.address),
					replyToAddresses: parsed.replyTo.map((entry) => entry.address),
					subject: parsed.subject,
					messageIdHeader: parsed.messageId,
					inReplyToHeader: parsed.inReplyTo,
					references: parsed.references,
					headers: parsed.headers,
					authResults: parsed.authResults,
					textBody: parsed.textBody,
					htmlBody: parsed.htmlBody,
					rawMimeKey: delivery.rawMimeKey,
					rawSize: parsed.rawSize,
					processingStatus: 'stored',
					providerMessageId: null,
					error: null,
					receivedAt: input.now,
					sentAt: null,
				},
			})
		} catch (error) {
			stored = await getEmailMessageById({
				db: input.db,
				userId: delivery.userId,
				messageId: delivery.messageId,
			}).catch(() => null)
			if (!stored) {
				throw new RetryableInboundStorageError(
					'Failed to commit inbound email message; the stable delivery will be retried.',
					error,
				)
			}
		}
	}

	try {
		await insertEmailAttachments({
			db: input.db,
			messageId: delivery.messageId,
			ignoreConflicts: true,
			inboundDeliveryFence,
			attachments: parsed.attachments.map((attachment, index) => ({
				id: `${delivery.messageId}:attachment:${index}`,
				filename: attachment.filename,
				contentType: attachment.contentType,
				contentId: attachment.contentId,
				disposition: attachment.disposition,
				size: attachment.size,
				storageKind: 'raw-mime',
				storageKey: null,
			})),
		})
	} catch (error) {
		throw new RetryableInboundStorageError(
			'Failed to commit inbound email attachments; the stable delivery will be retried.',
			error,
		)
	}
	const storedAttachments = await listEmailAttachmentsForMessage({
		db: input.db,
		messageId: delivery.messageId,
	}).catch((error: unknown) => {
		throw new RetryableInboundStorageError(
			'Failed to verify inbound email attachments; the stable delivery will be retried.',
			error,
		)
	})
	if (storedAttachments.length !== parsed.attachments.length) {
		throw new RetryableInboundStorageError(
			'Inbound email attachment commit was incomplete; the stable delivery will be retried.',
		)
	}

	let finalizedDelivery: InboundDelivery
	try {
		finalizedDelivery = await markInboundDeliveryReceived({
			db: input.db,
			delivery,
			usageDurationMs: delivery.usageStartedAt
				? Date.now() - Date.parse(delivery.usageStartedAt)
				: 0,
			usageMonth: (stored.receivedAt ?? stored.createdAt).slice(0, 7),
			usageBytes: stored.rawSize ?? 0,
		})
	} catch (error) {
		const committed = await getInboundDelivery({
			db: input.db,
			userId: delivery.userId,
			deliveryId: delivery.deliveryId,
		}).catch(() => null)
		if (committed?.state !== 'received') {
			throw new RetryableInboundStorageError(
				'Failed to finalize the inbound delivery ledger; the stable delivery will be retried.',
				error,
			)
		}
		finalizedDelivery = committed
	}
	try {
		if (stored.threadId) {
			await touchEmailThread({
				db: input.db,
				threadId: stored.threadId,
				lastMessageAt: input.now,
			})
		}
	} catch (error) {
		console.error(
			'inbound-email-post-commit-bookkeeping-failed',
			stored.id,
			error,
		)
	}
	return {
		message: stored,
		finalizedDelivery,
		wonFinalization:
			finalizedDelivery.finalizationToken === delivery.storageLease,
	}
}

export async function getEmailAttachmentById(input: {
	db: D1Database
	/** EMAIL_BLOBS bucket for messages whose raw MIME lives in R2. */
	blobs: R2Bucket
	userId: string
	attachmentId: string
}) {
	const attachment = await getEmailAttachmentRecordById({
		db: input.db,
		userId: input.userId,
		attachmentId: input.attachmentId,
	})
	if (!attachment) return null
	// Externally stored attachments (outbound mail) keep their bytes in a
	// dedicated R2 object instead of inside raw MIME.
	if (attachment.storageKind === 'external') {
		const object = attachment.storageKey
			? await input.blobs.get(attachment.storageKey)
			: null
		if (!object) {
			return { ...attachment, content: null, contentBase64: null }
		}
		const buffer = await object.arrayBuffer()
		return {
			...attachment,
			content: buffer,
			contentBase64: bytesToBase64(new Uint8Array(buffer)),
		}
	}
	if (attachment.storageKind === 'unavailable') {
		return { ...attachment, content: null, contentBase64: null }
	}
	const message = await getEmailMessageById({
		db: input.db,
		userId: input.userId,
		messageId: attachment.messageId,
	})
	const rawMime = message
		? await loadRawMime({ blobs: input.blobs, message })
		: null
	if (!rawMime) {
		return {
			...attachment,
			content: null,
			contentBase64: null,
		}
	}
	const parsed = await PostalMime.parse(rawMime, {
		attachmentEncoding: 'arraybuffer',
	})
	const matched = parsed.attachments.find((candidate) => {
		if ((candidate.filename ?? null) !== attachment.filename) return false
		if (candidate.mimeType !== (attachment.contentType ?? candidate.mimeType)) {
			return false
		}
		if ((candidate.contentId ?? null) !== attachment.contentId) return false
		if ((candidate.disposition ?? null) !== attachment.disposition) return false
		const content = candidate.content
		const size =
			typeof content === 'string'
				? new TextEncoder().encode(content).byteLength
				: content.byteLength
		return size === attachment.size
	})
	if (!matched) {
		return {
			...attachment,
			content: null,
			contentBase64: null,
		}
	}
	const bytes =
		typeof matched.content === 'string'
			? new TextEncoder().encode(matched.content)
			: new Uint8Array(matched.content)
	return {
		...attachment,
		content: matched.content,
		contentBase64: bytesToBase64(bytes),
	}
}

/**
 * How many quota/size/verification rejections per inbox per UTC day get
 * their own delivery-event row before collapsing into the daily aggregate
 * row.
 */
export const maxDetailedEmailRejectionEventsPerDay = 5

/**
 * Record an entitlement/size/verification rejection without unbounded row
 * growth. Every rejection upserts one aggregate 'rejected' event per inbox
 * per UTC day (deterministic id, counter in detail_json), and only the
 * first `maxDetailedEmailRejectionEventsPerDay` attempts of the day also
 * store an individual detailed event. This traffic is attacker-controlled
 * and not limited by the daily receive counter (over-quota mail has
 * already exhausted it; unverified-account mail never consumes it), so
 * without this cap a flood of rejected mail would grow D1 one row per
 * attempt — the denial-of-wallet shape the quotas exist to prevent.
 */
export async function recordBoundedEmailRejectionEvent(input: {
	db: D1Database
	userId: string
	inboxId: string
	recipient: string
	reason: string
	phase:
		| 'entitlement'
		| 'size'
		| 'account-verification'
		| 'account-suspension'
		| 'system-limit'
	now?: Date
}) {
	const now = input.now ?? new Date()
	const nowIsoString = now.toISOString()
	const day = isoTimestampDayKey(nowIsoString)
	const aggregateDetail = JSON.stringify({
		aggregate: true,
		day,
		count: 1,
		last_reason: input.reason,
		last_phase: input.phase,
		last_at: nowIsoString,
	})
	const row = await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, user_id, inbox_id, event_type, provider, detail_json, created_at
			) VALUES (?, ?, ?, 'rejected', 'cloudflare-email-routing', ?, ?)
			ON CONFLICT(id) DO UPDATE SET detail_json = json_set(
				email_delivery_events.detail_json,
				'$.count', COALESCE(json_extract(email_delivery_events.detail_json, '$.count'), 0) + 1,
				'$.last_reason', json_extract(excluded.detail_json, '$.last_reason'),
				'$.last_phase', json_extract(excluded.detail_json, '$.last_phase'),
				'$.last_at', json_extract(excluded.detail_json, '$.last_at')
			)
			RETURNING json_extract(detail_json, '$.count') AS count`,
		)
		.bind(
			`email-rejections:${input.inboxId}:${day}`,
			input.userId,
			input.inboxId,
			aggregateDetail,
			nowIsoString,
		)
		.first<{ count: number }>()
	const rejectionsToday = Number(row?.count ?? 1)
	if (rejectionsToday <= maxDetailedEmailRejectionEventsPerDay) {
		await insertEmailDeliveryEvent({
			db: input.db,
			userId: input.userId,
			inboxId: input.inboxId,
			eventType: 'rejected',
			provider: 'cloudflare-email-routing',
			detail: {
				recipient: input.recipient,
				reason: input.reason,
				phase: input.phase,
			},
		})
	}
	return rejectionsToday
}

export async function recordProviderEmailDeliveryEvent(input: {
	db: D1Database
	providerMessageId: string
	providerEventId: string
	deliveryStatus: EmailDeliveryStatus
	eventTimestamp: string
	detail: Record<string, unknown>
}) {
	const message = await getOutboundEmailMessageByProviderMessageId({
		db: input.db,
		providerMessageId: input.providerMessageId,
	})
	if (!message) {
		return { outcome: 'unmatched' as const, message: null }
	}

	const eventId = crypto.randomUUID()
	const statements = await input.db.batch([
		input.db
			.prepare(
				`INSERT OR IGNORE INTO email_delivery_events (
					id, message_id, user_id, inbox_id, event_type, provider,
					provider_message_id, provider_event_id, detail_json, created_at
				) VALUES (?, ?, ?, ?, ?, 'cloudflare-email', ?, ?, ?, ?)`,
			)
			.bind(
				eventId,
				message.id,
				message.userId,
				message.inboxId,
				input.deliveryStatus,
				input.providerMessageId,
				input.providerEventId,
				JSON.stringify(input.detail),
				input.eventTimestamp,
			),
		input.db
			.prepare(
				`UPDATE email_messages
				SET delivery_status = ?,
					delivery_status_at = ?,
					updated_at = ?
				WHERE id = ?
					AND (delivery_status_at IS NULL OR delivery_status_at <= ?)
					AND EXISTS (
						SELECT 1
						FROM email_delivery_events
						WHERE id = ?
							AND message_id = ?
					)`,
			)
			.bind(
				input.deliveryStatus,
				input.eventTimestamp,
				nowIso(),
				message.id,
				input.eventTimestamp,
				eventId,
				message.id,
			),
	])
	const inserted = Number(statements[0]?.meta.changes ?? 0) > 0
	const updatedLatestStatus = Number(statements[1]?.meta.changes ?? 0) > 0
	if (!inserted) {
		const duplicateIsCurrent =
			message.deliveryStatus === input.deliveryStatus &&
			message.deliveryStatusAt === input.eventTimestamp
		return {
			outcome: duplicateIsCurrent ? ('duplicate' as const) : ('stale' as const),
			message,
		}
	}
	if (!updatedLatestStatus) {
		return { outcome: 'stale' as const, message }
	}

	const updatedMessage = await getEmailMessageById({
		db: input.db,
		userId: message.userId,
		messageId: message.id,
	})
	if (!updatedMessage) {
		throw new Error(
			`Email message disappeared after delivery event: ${message.id}`,
		)
	}
	return {
		outcome: 'recorded' as const,
		message: updatedMessage,
		event: {
			id: eventId,
			messageId: message.id,
			userId: message.userId,
			inboxId: message.inboxId,
			eventType: input.deliveryStatus,
			provider: 'cloudflare-email',
			providerMessageId: input.providerMessageId,
			providerEventId: input.providerEventId,
			detailJson: JSON.stringify(input.detail),
			createdAt: input.eventTimestamp,
		} satisfies EmailDeliveryEventRecord,
	}
}
