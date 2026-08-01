import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxClassification,
	assertMailboxNonEmptyString,
	assertMailboxProcessingStatus,
	assertOptionalMailboxCanonicalIsoTimestamp,
	type MailboxAcceptedResult,
	type MailboxDeleteDeliveryEventResult,
	type MailboxDeleteMessageMetadataResult,
	type MailboxSetMessageClassificationInput,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
} from './mailbox-types.ts'

/**
 * Owner-bound partial mutation helpers for Mailbox SQLite metadata.
 * No R2 / alarm side effects — callers own transactions and retention.
 */

export function touchMailboxThread(
	sql: SqlStorage,
	input: Omit<MailboxTouchThreadInput, 'ownerId'>,
): MailboxAcceptedResult {
	const threadId = assertMailboxNonEmptyString(input.threadId, 'threadId')
	const lastMessageAt = assertMailboxCanonicalIsoTimestamp(
		input.lastMessageAt,
		'lastMessageAt',
	)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const cursor = sql.exec(
		`UPDATE email_threads
		SET last_message_at = CASE
				WHEN last_message_at < ? THEN ?
				ELSE last_message_at
			END,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		lastMessageAt,
		lastMessageAt,
		updatedAt,
		threadId,
		updatedAt,
	)
	return { accepted: cursor.rowsWritten > 0 }
}

export function updateMailboxMessageDelivery(
	sql: SqlStorage,
	input: Omit<MailboxUpdateMessageDeliveryInput, 'ownerId'>,
): MailboxAcceptedResult {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const processingStatus = assertMailboxProcessingStatus(input.processingStatus)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const sentAt = assertOptionalMailboxCanonicalIsoTimestamp(
		input.sentAt,
		'sentAt',
	)
	const cursor = sql.exec(
		`UPDATE email_messages
		SET processing_status = ?,
			provider_message_id = ?,
			error = ?,
			sent_at = ?,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		processingStatus,
		input.providerMessageId,
		input.error,
		sentAt,
		updatedAt,
		messageId,
		updatedAt,
	)
	return { accepted: cursor.rowsWritten > 0 }
}

export function setMailboxMessageClassification(
	sql: SqlStorage,
	input: Omit<MailboxSetMessageClassificationInput, 'ownerId'>,
): MailboxAcceptedResult {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const classification = assertMailboxClassification(input.classification)
	const updatedAt = assertMailboxCanonicalIsoTimestamp(
		input.updatedAt,
		'updatedAt',
	)
	const cursor = sql.exec(
		`UPDATE email_messages
		SET classification = ?,
			classification_reason = ?,
			updated_at = ?
		WHERE id = ?
			AND updated_at <= ?`,
		classification,
		input.classificationReason,
		updatedAt,
		messageId,
		updatedAt,
	)
	return { accepted: cursor.rowsWritten > 0 }
}

/**
 * Delete message + attachment metadata and any orphaned thread. Never deletes
 * R2 objects. Distinguishes missing (idempotent) from stale (newer retained).
 */
export function deleteMailboxMessageMetadata(
	sql: SqlStorage,
	input: { messageId: string; deletedAt: string },
): MailboxDeleteMessageMetadataResult {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = sql
		.exec<{ thread_id: string | null; updated_at: string }>(
			`SELECT thread_id, updated_at FROM email_messages
			WHERE id = ?
			LIMIT 1`,
			messageId,
		)
		.toArray()[0]
	if (existing == null) {
		return { deleted: false, stale: false }
	}
	if (existing.updated_at > deletedAt) {
		return { deleted: false, stale: true }
	}

	sql.exec(`DELETE FROM email_attachments WHERE message_id = ?`, messageId)
	const messageDelete = sql.exec(
		`DELETE FROM email_messages
		WHERE id = ?
			AND updated_at <= ?`,
		messageId,
		deletedAt,
	)
	if (messageDelete.rowsWritten === 0) {
		const stillThere = sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM email_messages WHERE id = ? LIMIT 1`,
				messageId,
			)
			.toArray()[0]
		return stillThere == null
			? { deleted: false, stale: false }
			: { deleted: false, stale: true }
	}

	const threadId = existing.thread_id
	if (threadId == null || threadId.length === 0) {
		return { deleted: true, stale: false, orphanThreadDeleted: false }
	}

	const orphanDelete = sql.exec(
		`DELETE FROM email_threads
		WHERE id = ?
			AND NOT EXISTS (
				SELECT 1 FROM email_messages
				WHERE thread_id = ?
			)`,
		threadId,
		threadId,
	)
	return {
		deleted: true,
		stale: false,
		orphanThreadDeleted: orphanDelete.rowsWritten > 0,
	}
}

/**
 * Delete a delivery-event row. SELECT `updated_at` first so missing and stale
 * are distinguishable; missing is idempotent success for best-effort callers.
 */
export function deleteMailboxDeliveryEvent(
	sql: SqlStorage,
	input: { eventId: string; deletedAt: string },
): MailboxDeleteDeliveryEventResult {
	const eventId = assertMailboxNonEmptyString(input.eventId, 'eventId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const existing = sql
		.exec<{ updated_at: string }>(
			`SELECT updated_at FROM email_delivery_events
			WHERE id = ?
			LIMIT 1`,
			eventId,
		)
		.toArray()[0]
	if (existing == null) {
		return { deleted: false, stale: false }
	}
	if (existing.updated_at > deletedAt) {
		return { deleted: false, stale: true }
	}

	const cursor = sql.exec(
		`DELETE FROM email_delivery_events
		WHERE id = ?
			AND updated_at <= ?`,
		eventId,
		deletedAt,
	)
	if (cursor.rowsWritten === 0) {
		const stillThere = sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM email_delivery_events WHERE id = ? LIMIT 1`,
				eventId,
			)
			.toArray()[0]
		return stillThere == null
			? { deleted: false, stale: false }
			: { deleted: false, stale: true }
	}
	return { deleted: true, stale: false }
}
