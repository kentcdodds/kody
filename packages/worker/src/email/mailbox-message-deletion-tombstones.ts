import { deleteMailboxMessageMetadata } from './mailbox-mutations.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxNonEmptyString,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxTombstoneMissingMessageResult,
} from './mailbox-types.ts'

/**
 * Migration-only fence against delayed D1 dual-write/parity resurrection.
 * Tombstones are intentionally retained until D1 message writers retire.
 */
export function isMailboxMessageTombstoned(
	sql: SqlStorage,
	messageId: string,
): boolean {
	const id = assertMailboxNonEmptyString(messageId, 'messageId')
	return (
		sql
			.exec<{ found: number }>(
				`SELECT 1 AS found
				FROM email_message_deletion_tombstones
				WHERE message_id = ?
				LIMIT 1`,
				id,
			)
			.toArray()[0] != null
	)
}

export function writeMailboxMessageDeletionTombstone(
	sql: SqlStorage,
	input: { messageId: string; deletedAt: string },
) {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	sql.exec(
		`INSERT INTO email_message_deletion_tombstones (message_id, deleted_at)
		VALUES (?, ?)
		ON CONFLICT(message_id) DO UPDATE SET
			deleted_at = MAX(email_message_deletion_tombstones.deleted_at, excluded.deleted_at)`,
		messageId,
		deletedAt,
	)
}

/**
 * Fence a missing message without racing a newly accepted mirror. The caller
 * must wrap this check-and-write in a SQLite transaction.
 */
export function tombstoneMissingMailboxMessage(
	sql: SqlStorage,
	input: { messageId: string; deletedAt: string },
): MailboxTombstoneMissingMessageResult {
	const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
	const deletedAt = assertMailboxCanonicalIsoTimestamp(
		input.deletedAt,
		'deletedAt',
	)
	const messagePresent =
		sql
			.exec<{ found: number }>(
				`SELECT 1 AS found FROM email_messages WHERE id = ? LIMIT 1`,
				messageId,
			)
			.toArray()[0] != null
	if (messagePresent) return { status: 'message-present' }

	const created = !isMailboxMessageTombstoned(sql, messageId)
	sql.exec(
		`UPDATE email_delivery_events
		SET message_id = NULL
		WHERE message_id = ?`,
		messageId,
	)
	writeMailboxMessageDeletionTombstone(sql, { messageId, deletedAt })
	return { status: 'tombstoned', created }
}

/**
 * Apply stale-safe metadata deletion and permanently fence accepted/missing
 * targets from delayed mirror recreation.
 */
export function deleteMailboxMessageMetadataWithTombstone(
	sql: SqlStorage,
	input: Omit<MailboxDeleteMessageMetadataInput, 'ownerId'>,
): MailboxDeleteResult {
	const result = deleteMailboxMessageMetadata(sql, input)
	if (result.status !== 'stale') {
		writeMailboxMessageDeletionTombstone(sql, input)
	}
	return result
}
