import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { isoTimestampDayKey } from '@kody-internal/shared/date-keys.ts'
import PostalMime from 'postal-mime'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import {
	EmailRawMimeStorageError,
	putEmailRawMime,
	RetryableInboundStorageError,
} from './email-raw-mime-store.ts'
import { resolveInboundEmailClassification } from './inbound-classification.ts'
import { type InboundDelivery } from './inbound-delivery.ts'
import { type UserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { recordBoundedSystemEmailRejection } from './system-inbound-delivery-store.ts'
import {
	mirrorMailboxMessageGraphFromD1,
	type MailboxLiveMirrorEnv,
} from './mailbox-live-mirror.ts'
import {
	recordEmailReportingEvent,
	type EmailReportingEnv,
} from './reporting-events.ts'
import {
	createEmailThread,
	deleteEmailMessageById,
	findEmailThreadForInboundMessage,
	getEmailAttachmentRecordById,
	getEmailMessageById,
	getOutboundEmailMessageByProviderMessageId,
	insertEmailAttachments,
	insertEmailDeliveryEvent,
	insertEmailMessage,
	listEmailAttachmentsForMessage,
	touchEmailThread,
	updateEmailMessageClassificationInD1,
} from './repo.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	deleteSystemEmailMessageById,
	getSystemEmailAttachmentById,
	getSystemEmailMessageById,
	insertSystemEmailAttachments,
	insertSystemEmailMessage,
	listSystemEmailAttachments,
	updateSystemEmailMessageClassification,
} from './system-email-graph-store.ts'
import {
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailDeliveryEventRecord,
	type EmailDeliveryStatus,
	type EmailMessageRecord,
	type ParsedInboundEmail,
} from './types.ts'

export { EmailRawMimeStorageError, RetryableInboundStorageError }

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

function systemInboundMessageInput(
	message: InsertEmailMessageInput['message'],
): Parameters<typeof insertSystemEmailMessage>[0]['message'] {
	if (
		message.userId !== systemEmailOwnerId ||
		message.direction !== 'inbound' ||
		message.providerMessageId != null
	) {
		throw new Error(
			'System inbound email requires system:email ownership without provider IDs.',
		)
	}
	const { direction, providerMessageId, userId, ...systemMessage } = message
	void direction
	void providerMessageId
	void userId
	return systemMessage
}

/**
 * Domain insert for messages that must not point at EMAIL_BLOBS raw MIME.
 * Forces `rawMimeKey: null` so callers cannot invent a key without a blob.
 * Inbound mail with raw MIME must use `insertEmailMessageWithRawMime`.
 */
export async function insertEmailMessageWithoutRawMime(
	input: InsertEmailMessageWithoutRawMimeInput,
) {
	const insertInput = {
		db: input.db,
		message: {
			...input.message,
			rawMimeKey: null,
		},
	}
	return input.message.userId === systemEmailOwnerId
		? await insertSystemEmailMessage({
				db: insertInput.db,
				message: systemInboundMessageInput(insertInput.message),
			})
		: await insertEmailMessage(insertInput)
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
			rawMimeKey = await putEmailRawMime({
				blobs,
				userId: messageInput.userId,
				messageId,
				rawMime,
			})
		}
		try {
			const insertInput = {
				db,
				message: {
					...messageInput,
					id: messageId,
					rawMimeKey,
				},
			}
			return messageInput.userId === systemEmailOwnerId
				? await insertSystemEmailMessage({
						db: insertInput.db,
						message: systemInboundMessageInput(insertInput.message),
					})
				: await insertEmailMessage(insertInput)
		} catch (error) {
			if (rawMimeKey != null) {
				await blobs.delete(rawMimeKey).catch(() => undefined)
			}
			throw error
		}
	}
	return messageInput.userId === systemEmailOwnerId
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
	const message =
		input.userId === systemEmailOwnerId
			? await getSystemEmailMessageById({
					db: input.db,
					messageId: input.messageId,
				})
			: await getEmailMessageById(input)
	if (!message) return null
	const attachments =
		input.userId === systemEmailOwnerId
			? await listSystemEmailAttachments({
					db: input.db,
					messageId: message.id,
				})
			: await listEmailAttachmentsForMessage({
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
		const attachmentInput = {
			db: input.db,
			messageId: message.id,
			attachments: input.attachments,
		}
		if (message.userId === systemEmailOwnerId) {
			await insertSystemEmailAttachments(attachmentInput)
		} else {
			await insertEmailAttachments(attachmentInput)
		}
		return message
	} catch (attachmentError) {
		let cleanupError: unknown
		try {
			if (message.userId === systemEmailOwnerId) {
				await deleteSystemEmailMessageById({
					db: input.db,
					blobs: input.blobs,
					messageId: message.id,
				})
			} else {
				await deleteEmailMessageById({
					db: input.db,
					blobs: input.blobs,
					messageId: message.id,
				})
			}
		} catch (error) {
			cleanupError = error
		}
		let remaining: Awaited<ReturnType<typeof getEmailMessageById>>
		try {
			remaining =
				message.userId === systemEmailOwnerId
					? await getSystemEmailMessageById({
							db: input.db,
							messageId: message.id,
						})
					: await getEmailMessageById({
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
	authority: Pick<UserInboundDeliveryAuthority, 'get' | 'receive'>
}) {
	const { delivery, parsed } = input
	if (delivery.userId === systemEmailOwnerId) {
		throw new Error(
			'System inbound storage must use the dedicated system email service.',
		)
	}
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
	await putEmailRawMime({
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
			const threadInput = {
				db: input.db,
				id: delivery.threadId,
				inboxId: delivery.inboxId,
				subjectNormalized: input.subjectNormalized,
				rootMessageIdHeader: parsed.messageId,
				lastMessageAt: input.now,
				ignoreConflict: true,
				inboundDeliveryFence,
			}
			thread = await createEmailThread({
				...threadInput,
				userId: delivery.userId,
			})
		}
		const { classification, classificationReason } =
			await resolveInboundEmailClassification({
				db: input.db,
				userId: delivery.userId,
				envelopeFrom: parsed.envelopeFrom,
				authResults: parsed.authResults,
			})
		try {
			const messageInput = {
				db: input.db,
				inboundDeliveryFence,
				message: {
					id: delivery.messageId,
					direction: 'inbound' as const,
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
					processingStatus: 'stored' as const,
					classification,
					classificationReason,
					providerMessageId: null,
					error: null,
					receivedAt: input.now,
					sentAt: null,
				},
			}
			stored = await insertEmailMessage(messageInput)
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
		const attachmentInput = {
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
		}
		await insertEmailAttachments(attachmentInput)
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

	const authority = input.authority
	if (!authority) {
		throw new Error('User inbound finalization requires Mailbox authority.')
	}
	let finalizedDelivery: InboundDelivery
	try {
		const finalization = {
			delivery,
			usageDurationMs: delivery.usageStartedAt
				? Date.now() - Date.parse(delivery.usageStartedAt)
				: 0,
			usageMonth: (stored.receivedAt ?? stored.createdAt).slice(0, 7),
			usageBytes: stored.rawSize ?? 0,
		}
		finalizedDelivery = await authority.receive(finalization)
	} catch (error) {
		const committed = await authority.get(delivery.deliveryId).catch(() => null)
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
			const touchInput = {
				db: input.db,
				threadId: stored.threadId,
				lastMessageAt: input.now,
			}
			await touchEmailThread(touchInput)
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

/**
 * Load attachment bytes after metadata selection. External attachments use
 * `EMAIL_BLOBS` via `storageKey`; raw-mime attachments parse the message's
 * raw MIME blob. Metadata may come from D1 or Mailbox.
 */
export async function loadEmailAttachmentContent(input: {
	blobs: R2Bucket
	attachment: EmailAttachmentRecord
	message: Pick<EmailMessageRecord, 'rawMimeKey'> | null
}) {
	const { attachment } = input
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
	const rawMime = input.message
		? await loadRawMime({ blobs: input.blobs, message: input.message })
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

export async function getEmailAttachmentById(input: {
	db: D1Database
	/** EMAIL_BLOBS bucket for messages whose raw MIME lives in R2. */
	blobs: R2Bucket
	userId: string
	attachmentId: string
}) {
	const attachment =
		input.userId === systemEmailOwnerId
			? await getSystemEmailAttachmentById({
					db: input.db,
					attachmentId: input.attachmentId,
				})
			: await getEmailAttachmentRecordById({
					db: input.db,
					userId: input.userId,
					attachmentId: input.attachmentId,
				})
	if (!attachment) return null
	const message =
		input.userId === systemEmailOwnerId
			? await getSystemEmailMessageById({
					db: input.db,
					messageId: attachment.messageId,
				})
			: await getEmailMessageById({
					db: input.db,
					userId: input.userId,
					messageId: attachment.messageId,
				})
	return loadEmailAttachmentContent({
		blobs: input.blobs,
		attachment,
		message,
	})
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
		| 'sender-policy'
		| 'system-limit'
	now?: Date
}) {
	const now = input.now ?? new Date()
	if (input.userId === systemEmailOwnerId) {
		return await recordBoundedSystemEmailRejection({
			db: input.db,
			inboxId: input.inboxId,
			recipient: input.recipient,
			reason: input.reason,
			phase: input.phase,
			now,
			detailLimit: maxDetailedEmailRejectionEventsPerDay,
		})
	}
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
				id, user_id, inbox_id, event_type, provider, detail_json,
				needs_effect_reconcile, created_at
			) VALUES (?, ?, ?, 'rejected', 'cloudflare-email-routing', ?, 0, ?)
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

/**
 * Reclassify a stored inbound message and, on D1 success only, best-effort
 * mirror the full message graph into Mailbox. Returns the D1 mutation boolean;
 * mirror failures never throw or change that response.
 */
export async function setEmailMessageClassification(input: {
	env: MailboxLiveMirrorEnv
	db: D1Database
	userId: string
	messageId: string
	classification: EmailClassification
	classificationReason?: string | null
	now?: string
}) {
	const updated =
		input.userId === systemEmailOwnerId
			? await updateSystemEmailMessageClassification({
					db: input.db,
					messageId: input.messageId,
					classification: input.classification,
					classificationReason: input.classificationReason,
					now: input.now,
				})
			: await updateEmailMessageClassificationInD1({
					db: input.db,
					userId: input.userId,
					messageId: input.messageId,
					classification: input.classification,
					classificationReason: input.classificationReason,
					now: input.now,
				})
	if (!updated) {
		return false
	}
	if (input.userId !== systemEmailOwnerId) {
		await mirrorMailboxMessageGraphFromD1({
			env: input.env,
			db: input.db,
			userId: input.userId,
			messageId: input.messageId,
		})
	}
	return true
}

/**
 * Record a Cloudflare outbound delivery lifecycle event. Resolution is
 * index-first via `email_outbound_provider_index`, then an owner-scoped
 * `email_messages` load — never a full-table provider_message_id scan.
 */
export async function recordProviderEmailDeliveryEvent(input: {
	db: D1Database
	reportingEnv?: EmailReportingEnv
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
	if (input.reportingEnv) {
		recordEmailReportingEvent(input.reportingEnv, {
			userId: message.userId,
			eventType: 'email_delivery',
			outcome: input.deliveryStatus,
			timestamp: input.eventTimestamp,
		})
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
