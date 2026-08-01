import {
	mailboxBlobDeleteMaxKeys,
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionBatchSize,
	mailboxRetentionRetryDelayMs,
} from './mailbox-types.ts'
import { type MailboxStore } from './mailbox-store.ts'

const messageRetentionMs = mailboxMessageRetentionDays * 24 * 60 * 60 * 1000
const deliveryEventRetentionMs =
	mailboxDeliveryEventRetentionDays * 24 * 60 * 60 * 1000

export type MailboxRetentionPassResult = {
	/** True when at least one message blob delete failed (row retained). */
	hadBlobDeleteFailures: boolean
}

/**
 * Soonest retention due-time from stored rows, or null when empty.
 * Overdue rows yield timestamps in the past — callers must apply retry backoff
 * instead of scheduling at now+1s.
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
 * Schedule time for the next retention alarm.
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

async function pruneExpiredMessages(input: {
	store: MailboxStore
	blobs: Pick<R2Bucket, 'delete'>
}): Promise<boolean> {
	const cutoff = new Date(Date.now() - messageRetentionMs).toISOString()
	const rows = input.store.listExpiredMessagesForRetention({
		cutoff,
		limit: mailboxRetentionBatchSize,
	})
	if (rows.length === 0) return false

	const attachmentRows = input.store.listAttachmentStorageKeysForMessages(
		rows.map((row) => row.id),
	)
	const attachmentKeysByMessageId = new Map<string, Array<string>>()
	for (const attachment of attachmentRows) {
		const keys = attachmentKeysByMessageId.get(attachment.message_id)
		if (keys) keys.push(attachment.storage_key)
		else {
			attachmentKeysByMessageId.set(attachment.message_id, [
				attachment.storage_key,
			])
		}
	}

	let hadBlobDeleteFailures = false
	for (const row of rows) {
		const keys = [
			...(row.raw_mime_key ? [row.raw_mime_key] : []),
			...(attachmentKeysByMessageId.get(row.id) ?? []),
		]
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
	const hadBlobDeleteFailures = await pruneExpiredMessages(input)
	const eventCutoff = new Date(
		Date.now() - deliveryEventRetentionMs,
	).toISOString()
	input.store.pruneExpiredDeliveryEvents({
		cutoff: eventCutoff,
		limit: mailboxRetentionBatchSize,
	})
	input.store.pruneOrphanThreads(mailboxRetentionBatchSize)
	return { hadBlobDeleteFailures }
}
