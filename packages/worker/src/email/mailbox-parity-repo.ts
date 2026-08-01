import { systemEmailOwnerId } from './email-owner.ts'
import { type MailboxCountResult } from './mailbox-types.ts'

/**
 * D1 loaders/persisters for the hourly Mailbox parity reconcile lane.
 * Creation backfill uses (created_at, id) keysets; content replay uses
 * (updated_at, id) within (watermark, now].
 */

export type MailboxParityBackfillCursor = {
	createdAt: string
	id: string
}

export type MailboxParityContentCursor = {
	updatedAt: string
	id: string
}

export type MailboxParityUserState = {
	userId: string
	matchingSince: string | null
	mismatchCount: number
	contentWatermarkAt: string | null
	messageCursor: MailboxParityBackfillCursor | null
	messagesCompletedAt: string | null
	orphanEventCursor: MailboxParityBackfillCursor | null
	orphanEventsCompletedAt: string | null
}

export type MailboxParityCreatedKeysetRow = {
	id: string
	created_at: string
}

export type MailboxParityUpdatedKeysetRow = {
	id: string
	updated_at: string
}

export async function listUsersForMailboxParity(input: {
	db: D1Database
	limit: number
}): Promise<Array<{ userId: string }>> {
	const result = await input.db
		.prepare(
			`SELECT u.stable_user_id AS userId
			FROM users u
			WHERE u.deleting_at IS NULL
				AND u.stable_user_id != ?
				AND (
					EXISTS (
						SELECT 1 FROM email_messages m
						WHERE m.user_id = u.stable_user_id
					)
					OR EXISTS (
						SELECT 1 FROM email_delivery_events e
						WHERE e.user_id = u.stable_user_id
					)
				)
			ORDER BY u.mailbox_parity_checked_at ASC, u.stable_user_id ASC
			LIMIT ?`,
		)
		.bind(systemEmailOwnerId, input.limit)
		.all<{ userId: string }>()
	return result.results ?? []
}

export async function countD1MailboxParity(input: {
	db: D1Database
	userId: string
}): Promise<MailboxCountResult> {
	const [threads, messages, attachments, deliveryEvents] = await Promise.all([
		input.db
			.prepare(`SELECT COUNT(*) AS n FROM email_threads WHERE user_id = ?`)
			.bind(input.userId)
			.first<{ n: number }>(),
		input.db
			.prepare(`SELECT COUNT(*) AS n FROM email_messages WHERE user_id = ?`)
			.bind(input.userId)
			.first<{ n: number }>(),
		input.db
			.prepare(
				`SELECT COUNT(*) AS n
				FROM email_attachments ea
				JOIN email_messages em ON em.id = ea.message_id
				WHERE em.user_id = ?`,
			)
			.bind(input.userId)
			.first<{ n: number }>(),
		input.db
			.prepare(
				`SELECT COUNT(*) AS n FROM email_delivery_events WHERE user_id = ?`,
			)
			.bind(input.userId)
			.first<{ n: number }>(),
	])
	return {
		threads: Number(threads?.n ?? 0) || 0,
		messages: Number(messages?.n ?? 0) || 0,
		attachments: Number(attachments?.n ?? 0) || 0,
		deliveryEvents: Number(deliveryEvents?.n ?? 0) || 0,
	}
}

export async function loadUserParityState(input: {
	db: D1Database
	userId: string
}): Promise<MailboxParityUserState | null> {
	const row = await input.db
		.prepare(
			`SELECT
				stable_user_id AS userId,
				mailbox_parity_matching_since AS matchingSince,
				mailbox_parity_mismatch_count AS mismatchCount,
				mailbox_parity_content_watermark_at AS contentWatermarkAt,
				mailbox_parity_message_backfill_cursor_created_at AS messageCursorCreatedAt,
				mailbox_parity_message_backfill_cursor_id AS messageCursorId,
				mailbox_parity_message_backfill_completed_at AS messagesCompletedAt,
				mailbox_parity_orphan_event_backfill_cursor_created_at AS orphanCursorCreatedAt,
				mailbox_parity_orphan_event_backfill_cursor_id AS orphanCursorId,
				mailbox_parity_orphan_event_backfill_completed_at AS orphanEventsCompletedAt
			FROM users
			WHERE stable_user_id = ?
				AND deleting_at IS NULL
			LIMIT 1`,
		)
		.bind(input.userId)
		.first<{
			userId: string
			matchingSince: string | null
			mismatchCount: number | null
			contentWatermarkAt: string | null
			messageCursorCreatedAt: string | null
			messageCursorId: string | null
			messagesCompletedAt: string | null
			orphanCursorCreatedAt: string | null
			orphanCursorId: string | null
			orphanEventsCompletedAt: string | null
		}>()
	if (!row) return null
	const messageCursor =
		row.messageCursorCreatedAt != null && row.messageCursorId != null
			? { createdAt: row.messageCursorCreatedAt, id: row.messageCursorId }
			: null
	const orphanEventCursor =
		row.orphanCursorCreatedAt != null && row.orphanCursorId != null
			? { createdAt: row.orphanCursorCreatedAt, id: row.orphanCursorId }
			: null
	return {
		userId: row.userId,
		matchingSince: row.matchingSince,
		mismatchCount: Number(row.mismatchCount ?? 0) || 0,
		contentWatermarkAt: row.contentWatermarkAt,
		messageCursor,
		messagesCompletedAt: row.messagesCompletedAt,
		orphanEventCursor,
		orphanEventsCompletedAt: row.orphanEventsCompletedAt,
	}
}

export async function listMessageBackfillPage(input: {
	db: D1Database
	userId: string
	cursor: MailboxParityBackfillCursor | null
	limit: number
}): Promise<Array<MailboxParityCreatedKeysetRow>> {
	const result =
		input.cursor == null
			? await input.db
					.prepare(
						`SELECT id, created_at
						FROM email_messages
						WHERE user_id = ?
						ORDER BY created_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(input.userId, input.limit)
					.all<MailboxParityCreatedKeysetRow>()
			: await input.db
					.prepare(
						`SELECT id, created_at
						FROM email_messages
						WHERE user_id = ?
							AND (
								created_at > ?
								OR (created_at = ? AND id > ?)
							)
						ORDER BY created_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(
						input.userId,
						input.cursor.createdAt,
						input.cursor.createdAt,
						input.cursor.id,
						input.limit,
					)
					.all<MailboxParityCreatedKeysetRow>()
	return result.results ?? []
}

/**
 * Cohesive D1 loader for owner-scoped delivery events with `message_id` null
 * (orphan / unbound ledger rows). Keyset-paged for bounded backfill.
 */
export async function listOrphanDeliveryEventBackfillPage(input: {
	db: D1Database
	userId: string
	cursor: MailboxParityBackfillCursor | null
	limit: number
}): Promise<Array<MailboxParityCreatedKeysetRow>> {
	const result =
		input.cursor == null
			? await input.db
					.prepare(
						`SELECT id, created_at
						FROM email_delivery_events
						WHERE user_id = ?
							AND message_id IS NULL
						ORDER BY created_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(input.userId, input.limit)
					.all<MailboxParityCreatedKeysetRow>()
			: await input.db
					.prepare(
						`SELECT id, created_at
						FROM email_delivery_events
						WHERE user_id = ?
							AND message_id IS NULL
							AND (
								created_at > ?
								OR (created_at = ? AND id > ?)
							)
						ORDER BY created_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(
						input.userId,
						input.cursor.createdAt,
						input.cursor.createdAt,
						input.cursor.id,
						input.limit,
					)
					.all<MailboxParityCreatedKeysetRow>()
	return result.results ?? []
}

/**
 * Keyset page of owner messages updated after `watermarkAt` and at or before
 * `upperBoundAt` (run now, or wall time when completing in the baseline run).
 * In-tick `cursor` continues within the same window without skipping equal
 * `updated_at` rows.
 */
export async function listContentReplayPage(input: {
	db: D1Database
	userId: string
	watermarkAt: string
	upperBoundAt: string
	cursor: MailboxParityContentCursor | null
	limit: number
}): Promise<Array<MailboxParityUpdatedKeysetRow>> {
	const result =
		input.cursor == null
			? await input.db
					.prepare(
						`SELECT id, updated_at
						FROM email_messages
						WHERE user_id = ?
							AND updated_at > ?
							AND updated_at <= ?
						ORDER BY updated_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(
						input.userId,
						input.watermarkAt,
						input.upperBoundAt,
						input.limit,
					)
					.all<MailboxParityUpdatedKeysetRow>()
			: await input.db
					.prepare(
						`SELECT id, updated_at
						FROM email_messages
						WHERE user_id = ?
							AND updated_at <= ?
							AND (
								updated_at > ?
								OR (updated_at = ? AND id > ?)
							)
						ORDER BY updated_at ASC, id ASC
						LIMIT ?`,
					)
					.bind(
						input.userId,
						input.upperBoundAt,
						input.cursor.updatedAt,
						input.cursor.updatedAt,
						input.cursor.id,
						input.limit,
					)
					.all<MailboxParityUpdatedKeysetRow>()
	return result.results ?? []
}

export async function persistUserParityProgress(input: {
	db: D1Database
	userId: string
	nowIso: string
	matchingSince: string | null
	mismatchCount: number
	contentWatermarkAt: string | null
	messageCursor: MailboxParityBackfillCursor | null
	messagesCompletedAt: string | null
	orphanEventCursor: MailboxParityBackfillCursor | null
	orphanEventsCompletedAt: string | null
	lastError: string | null
}) {
	await input.db
		.prepare(
			`UPDATE users
			SET mailbox_parity_checked_at = ?,
				mailbox_parity_matching_since = ?,
				mailbox_parity_mismatch_count = ?,
				mailbox_parity_last_error = ?,
				mailbox_parity_content_watermark_at = ?,
				mailbox_parity_message_backfill_cursor_created_at = ?,
				mailbox_parity_message_backfill_cursor_id = ?,
				mailbox_parity_message_backfill_completed_at = ?,
				mailbox_parity_orphan_event_backfill_cursor_created_at = ?,
				mailbox_parity_orphan_event_backfill_cursor_id = ?,
				mailbox_parity_orphan_event_backfill_completed_at = ?
			WHERE stable_user_id = ?`,
		)
		.bind(
			input.nowIso,
			input.matchingSince,
			input.mismatchCount,
			input.lastError,
			input.contentWatermarkAt,
			input.messageCursor?.createdAt ?? null,
			input.messageCursor?.id ?? null,
			input.messagesCompletedAt,
			input.orphanEventCursor?.createdAt ?? null,
			input.orphanEventCursor?.id ?? null,
			input.orphanEventsCompletedAt,
			input.userId,
		)
		.run()
}

export async function rotateCheckedAt(input: {
	db: D1Database
	userId: string
	nowIso: string
	lastError: string | null
}) {
	// Clears matching_since so a poison/error tick cannot preserve a false soak.
	// Zero-row updates (deleted/deleting race) are harmless.
	await input.db
		.prepare(
			`UPDATE users
			SET mailbox_parity_checked_at = ?,
				mailbox_parity_last_error = ?,
				mailbox_parity_matching_since = NULL
			WHERE stable_user_id = ?`,
		)
		.bind(input.nowIso, input.lastError, input.userId)
		.run()
}
