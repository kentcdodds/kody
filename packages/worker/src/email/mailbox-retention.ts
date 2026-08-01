import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	mailboxBlobDeleteMaxKeys,
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionAlarmSkewMs,
	mailboxRetentionBatchSize,
	mailboxRetentionContinuationDelayMs,
	mailboxRetentionRetryDelayMs,
} from './mailbox-types.ts'
import { type MailboxStore } from './mailbox-store.ts'

const messageRetentionMs = mailboxMessageRetentionDays * 24 * 60 * 60 * 1000
const deliveryEventRetentionMs =
	mailboxDeliveryEventRetentionDays * 24 * 60 * 60 * 1000

export type MailboxRetentionPassResult = {
	/** True when at least one message blob delete failed (row retained). */
	hadBlobDeleteFailures: boolean
	/** True when expired rows remain after a successful bounded pass. */
	expiredWorkRemaining: boolean
}

export type MailboxRetentionRescheduleKind =
	| 'idle'
	| 'backoff'
	| 'continue'
	| 'next-due'

export type MailboxRetentionReschedule = {
	kind: MailboxRetentionRescheduleKind
	atMs: number | null
}

/**
 * Deterministic next-alarm choice after a retention pass.
 * - Blob delete failures → hourly backoff only
 * - Successful pass with expired rows remaining → near-immediate continuation
 * - Otherwise → future due-time (or idle)
 */
export function computeMailboxRetentionReschedule(input: {
	nowMs: number
	hadBlobDeleteFailures: boolean
	expiredWorkRemaining: boolean
	nextDueAtMs: number | null
	continuationDelayMs?: number
	backoffMs?: number
}): MailboxRetentionReschedule {
	const backoffMs = input.backoffMs ?? mailboxRetentionRetryDelayMs
	const continuationDelayMs =
		input.continuationDelayMs ?? mailboxRetentionContinuationDelayMs
	if (input.hadBlobDeleteFailures) {
		return { kind: 'backoff', atMs: input.nowMs + backoffMs }
	}
	if (input.expiredWorkRemaining) {
		return { kind: 'continue', atMs: input.nowMs + continuationDelayMs }
	}
	if (input.nextDueAtMs == null) {
		return { kind: 'idle', atMs: null }
	}
	return { kind: 'next-due', atMs: input.nextDueAtMs }
}

/**
 * Soonest retention due-time from stored rows, or null when empty.
 * Overdue rows yield timestamps in the past — callers must apply retry backoff
 * or continuation instead of scheduling at now+1s blindly.
 */
export function nextMailboxRetentionDueAtMs(
	store: MailboxStore,
): number | null {
	let next: number | null = null
	const consider = (at: number) => {
		if (!Number.isFinite(at)) return
		if (next == null || at < next) next = at
	}

	const oldestMessage = store.oldestMessageCreatedAt()
	if (oldestMessage) {
		consider(Date.parse(oldestMessage) + messageRetentionMs)
	}
	const oldestEvent = store.oldestDeliveryEventCreatedAt()
	if (oldestEvent) {
		consider(Date.parse(oldestEvent) + deliveryEventRetentionMs)
	}
	return next
}

/**
 * Schedule time for the next retention alarm on a write path.
 * - Future due-time → schedule at due-time
 * - Overdue work → bounded hourly backoff (avoids 1s storms on persistent R2 failure)
 */
export function mailboxRetentionAlarmAtMs(input: {
	dueAtMs: number | null
	nowMs?: number
}): number | null {
	if (input.dueAtMs == null) return null
	const nowMs = input.nowMs ?? Date.now()
	if (input.dueAtMs <= nowMs) {
		return nowMs + mailboxRetentionRetryDelayMs
	}
	return input.dueAtMs
}

export type MailboxRetentionWriteAlarmSelection =
	| { action: 'idle' }
	| { action: 'keep-existing' }
	| { action: 'set'; atMs: number }

/**
 * Choose whether a write-path ensure should set, keep, or clear interest in
 * an alarm. Sustained writes must never postpone an earlier existing alarm;
 * near-equal times within skew keep the existing alarm to avoid churn.
 */
export function selectMailboxRetentionWriteAlarm(input: {
	proposedAtMs: number | null
	existingAtMs: number | null
	skewMs?: number
}): MailboxRetentionWriteAlarmSelection {
	if (input.proposedAtMs == null) {
		return { action: 'idle' }
	}
	const existingAtMs = input.existingAtMs
	if (existingAtMs == null) {
		return { action: 'set', atMs: input.proposedAtMs }
	}
	const skewMs = input.skewMs ?? mailboxRetentionAlarmSkewMs
	if (Math.abs(existingAtMs - input.proposedAtMs) < skewMs) {
		return { action: 'keep-existing' }
	}
	// Existing fires sooner — never postpone retention for a later proposal.
	if (existingAtMs < input.proposedAtMs) {
		return { action: 'keep-existing' }
	}
	return { action: 'set', atMs: input.proposedAtMs }
}

async function deleteBlobKeys(
	blobs: Pick<R2Bucket, 'delete'>,
	keys: Array<string>,
): Promise<boolean> {
	if (keys.length === 0) return true
	try {
		for (
			let index = 0;
			index < keys.length;
			index += mailboxBlobDeleteMaxKeys
		) {
			const chunk = keys.slice(index, index + mailboxBlobDeleteMaxKeys)
			await blobs.delete(chunk)
		}
		return true
	} catch (error) {
		console.warn('mailbox-retention-blob-delete-failed', { error })
		return false
	}
}

/**
 * Build owner-safe R2 keys for an expired message. Never deletes arbitrary
 * stored key strings — only canonical inbound raw MIME keys and matching
 * external attachment keys.
 */
export function canonicalRetentionBlobKeys(input: {
	ownerId: string
	messageId: string
	direction: 'inbound' | 'outbound'
	attachments: Array<{ id: string; storage_key: string | null }>
}): Array<string> {
	const keys: Array<string> = []
	if (input.direction === 'inbound') {
		keys.push(emailRawMimeKey(input.ownerId, input.messageId))
	}
	for (const attachment of input.attachments) {
		if (attachment.storage_key == null) continue
		const expected = emailAttachmentBlobKey(
			input.ownerId,
			input.messageId,
			attachment.id,
		)
		if (attachment.storage_key === expected) {
			keys.push(expected)
		}
	}
	return keys
}

async function pruneExpiredMessages(input: {
	store: MailboxStore
	blobs: Pick<R2Bucket, 'delete'>
	ownerId: string
}): Promise<boolean> {
	const cutoff = new Date(Date.now() - messageRetentionMs).toISOString()
	const rows = input.store.listExpiredMessagesForRetention({
		cutoff,
		limit: mailboxRetentionBatchSize,
	})
	if (rows.length === 0) return false

	const attachmentRows = input.store.listAttachmentsForRetention(
		rows.map((row) => row.id),
	)
	const attachmentsByMessageId = new Map<
		string,
		Array<{ id: string; storage_key: string | null }>
	>()
	for (const attachment of attachmentRows) {
		const list = attachmentsByMessageId.get(attachment.message_id)
		if (list) list.push(attachment)
		else {
			attachmentsByMessageId.set(attachment.message_id, [attachment])
		}
	}

	let hadBlobDeleteFailures = false
	for (const row of rows) {
		const keys = canonicalRetentionBlobKeys({
			ownerId: input.ownerId,
			messageId: row.id,
			direction: row.direction,
			attachments: attachmentsByMessageId.get(row.id) ?? [],
		})
		const blobsDeleted = await deleteBlobKeys(input.blobs, keys)
		if (!blobsDeleted) {
			hadBlobDeleteFailures = true
			continue
		}
		input.store.deleteMessageCascade(row.id)
	}
	return hadBlobDeleteFailures
}

export async function enforceMailboxRetention(input: {
	store: MailboxStore
	blobs: Pick<R2Bucket, 'delete'>
}): Promise<MailboxRetentionPassResult> {
	const messageCutoff = new Date(Date.now() - messageRetentionMs).toISOString()
	const eventCutoff = new Date(
		Date.now() - deliveryEventRetentionMs,
	).toISOString()

	const ownerId = input.store.getOwnerId()
	let hadBlobDeleteFailures = false
	if (ownerId) {
		hadBlobDeleteFailures = await pruneExpiredMessages({
			store: input.store,
			blobs: input.blobs,
			ownerId,
		})
	}

	input.store.pruneExpiredDeliveryEvents({
		cutoff: eventCutoff,
		limit: mailboxRetentionBatchSize,
	})
	input.store.pruneOrphanThreads(mailboxRetentionBatchSize)

	const expiredWorkRemaining =
		input.store.hasExpiredMessages(messageCutoff) ||
		input.store.hasExpiredDeliveryEvents(eventCutoff)

	return { hadBlobDeleteFailures, expiredWorkRemaining }
}
