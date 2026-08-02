import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	mailboxBlobDeleteMaxKeys,
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionAlarmSkewMs,
	mailboxRetentionBatchSize,
	mailboxRetentionContinuationDelayMs,
	mailboxRetentionRetryDelayMs,
	type MailboxBlobReference,
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

export type MailboxRetentionMessageCandidate = {
	id: string
	direction: 'inbound' | 'outbound'
	created_at: string
	updated_at: string
}

export type MailboxRetentionMessageDeleteResult =
	| 'deleted'
	| 'skipped'
	| 'blob-delete-failed'

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

export async function deleteMailboxBlobKeys(
	blobs: Pick<R2Bucket, 'delete'>,
	keys: Array<string>,
): Promise<void> {
	if (keys.length === 0) return
	for (let index = 0; index < keys.length; index += mailboxBlobDeleteMaxKeys) {
		const chunk = keys.slice(index, index + mailboxBlobDeleteMaxKeys)
		await blobs.delete(chunk)
	}
}

/**
 * Build owner-safe R2 keys for an expired message. Never deletes arbitrary
 * stored key strings — only canonical inbound raw MIME keys and matching
 * external attachment keys.
 */
export function canonicalMailboxMessageBlobReferences(input: {
	ownerId: string
	messageId: string
	direction: 'inbound' | 'outbound'
	attachments: Array<{ id: string; storage_key: string | null }>
}): Array<MailboxBlobReference> {
	const references: Array<MailboxBlobReference> = []
	if (input.direction === 'inbound') {
		references.push({
			kind: 'raw_mime',
			key: emailRawMimeKey(input.ownerId, input.messageId),
			messageId: input.messageId,
			attachmentId: null,
		})
	}
	for (const attachment of input.attachments) {
		if (attachment.storage_key == null) continue
		const expected = emailAttachmentBlobKey(
			input.ownerId,
			input.messageId,
			attachment.id,
		)
		if (attachment.storage_key === expected) {
			references.push({
				kind: 'attachment',
				key: expected,
				messageId: input.messageId,
				attachmentId: attachment.id,
			})
		}
	}
	return references
}

export function canonicalRetentionBlobKeys(
	input: Parameters<typeof canonicalMailboxMessageBlobReferences>[0],
): Array<string> {
	return canonicalMailboxMessageBlobReferences(input).map(
		(reference) => reference.key,
	)
}

/**
 * Revalidate one previously selected message, delete its canonical blobs in
 * bounded R2 chunks, then tombstone/delete metadata. The DO caller must place
 * exactly this operation inside one safe input gate.
 */
export async function deleteMailboxRetentionCandidate(input: {
	store: MailboxStore
	blobs: Pick<R2Bucket, 'delete'>
	ownerId: string
	candidate: MailboxRetentionMessageCandidate
	cutoff: string
}): Promise<MailboxRetentionMessageDeleteResult> {
	const current = input.store.getMessageForRetention(input.candidate.id)
	if (
		current == null ||
		current.created_at >= input.cutoff ||
		current.created_at !== input.candidate.created_at ||
		current.updated_at !== input.candidate.updated_at ||
		current.direction !== input.candidate.direction
	) {
		return 'skipped'
	}

	const keys = canonicalRetentionBlobKeys({
		ownerId: input.ownerId,
		messageId: current.id,
		direction: current.direction,
		attachments: input.store.listAttachmentsForRetention([current.id]),
	})
	try {
		await deleteMailboxBlobKeys(input.blobs, keys)
	} catch (error) {
		console.warn('mailbox-retention-blob-delete-failed', { error })
		return 'blob-delete-failed'
	}
	input.store.tombstoneAndDeleteMessage({
		messageId: current.id,
		deletedAt: new Date().toISOString(),
	})
	return 'deleted'
}

async function pruneExpiredMessages(input: {
	store: MailboxStore
	cutoff: string
	deleteMessage: (
		candidate: MailboxRetentionMessageCandidate,
		cutoff: string,
	) => Promise<MailboxRetentionMessageDeleteResult>
	yieldBetweenMessages: () => Promise<void>
}): Promise<boolean> {
	const rows = input.store.listExpiredMessagesForRetention({
		cutoff: input.cutoff,
		limit: mailboxRetentionBatchSize,
	})
	if (rows.length === 0) return false

	let hadBlobDeleteFailures = false
	for (const [index, row] of rows.entries()) {
		const result = await input.deleteMessage(row, input.cutoff)
		if (result === 'blob-delete-failed') {
			hadBlobDeleteFailures = true
		}
		if (index < rows.length - 1) {
			await input.yieldBetweenMessages()
		}
	}
	return hadBlobDeleteFailures
}

export async function enforceMailboxRetention(input: {
	store: MailboxStore
	deleteMessage: (
		candidate: MailboxRetentionMessageCandidate,
		cutoff: string,
	) => Promise<MailboxRetentionMessageDeleteResult>
	yieldBetweenMessages: () => Promise<void>
}): Promise<MailboxRetentionPassResult> {
	const messageCutoff = new Date(Date.now() - messageRetentionMs).toISOString()
	const eventCutoff = new Date(
		Date.now() - deliveryEventRetentionMs,
	).toISOString()

	const hadBlobDeleteFailures = await pruneExpiredMessages({
		store: input.store,
		cutoff: messageCutoff,
		deleteMessage: input.deleteMessage,
		yieldBetweenMessages: input.yieldBetweenMessages,
	})

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
