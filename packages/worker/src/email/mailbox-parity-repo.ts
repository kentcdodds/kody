import { systemEmailOwnerId } from './email-owner.ts'
import { type MailboxCountResult } from './mailbox-types.ts'

/**
 * D1 loaders/persisters for the five-minute Mailbox parity reconcile lane.
 * Creation backfill uses (created_at, id) keysets over messages and all owner
 * delivery events; content replay uses a durable (watermark, upper] window with
 * an (updated_at, id) cursor.
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
	contentReplayUpperAt: string | null
	contentReplayCursor: MailboxParityContentCursor | null
	messageCursor: MailboxParityBackfillCursor | null
	messagesCompletedAt: string | null
	eventCursor: MailboxParityBackfillCursor | null
	eventsCompletedAt: string | null
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
	// Include previously tracked owners (any parity column non-null) even when
	// D1 mail is empty so DO-only leftovers after last-row deletion are purged.
	// Never-tracked empty users, system email, and deleting users stay out.
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
					OR u.mailbox_parity_checked_at IS NOT NULL
					OR u.mailbox_parity_matching_since IS NOT NULL
					OR u.mailbox_parity_last_error IS NOT NULL
					OR u.mailbox_parity_mismatch_count > 0
					OR u.mailbox_parity_content_watermark_at IS NOT NULL
					OR u.mailbox_parity_content_replay_upper_at IS NOT NULL
					OR u.mailbox_parity_content_replay_cursor_id IS NOT NULL
					OR u.mailbox_parity_message_backfill_cursor_id IS NOT NULL
					OR u.mailbox_parity_message_backfill_completed_at IS NOT NULL
					OR u.mailbox_parity_event_backfill_cursor_id IS NOT NULL
					OR u.mailbox_parity_event_backfill_completed_at IS NOT NULL
				)
			ORDER BY u.mailbox_parity_checked_at ASC, u.stable_user_id ASC
			LIMIT ?`,
		)
		.bind(systemEmailOwnerId, input.limit)
		.all<{ userId: string }>()
	return result.results ?? []
}

export async function isUserDeleting(input: {
	db: D1Database
	userId: string
}): Promise<boolean> {
	const row = await input.db
		.prepare(
			`SELECT deleting_at AS deletingAt
			FROM users
			WHERE stable_user_id = ?
			LIMIT 1`,
		)
		.bind(input.userId)
		.first<{ deletingAt: string | null }>()
	return row == null || row.deletingAt != null
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
				mailbox_parity_content_replay_upper_at AS contentReplayUpperAt,
				mailbox_parity_content_replay_cursor_updated_at AS contentReplayCursorUpdatedAt,
				mailbox_parity_content_replay_cursor_id AS contentReplayCursorId,
				mailbox_parity_message_backfill_cursor_created_at AS messageCursorCreatedAt,
				mailbox_parity_message_backfill_cursor_id AS messageCursorId,
				mailbox_parity_message_backfill_completed_at AS messagesCompletedAt,
				mailbox_parity_event_backfill_cursor_created_at AS eventCursorCreatedAt,
				mailbox_parity_event_backfill_cursor_id AS eventCursorId,
				mailbox_parity_event_backfill_completed_at AS eventsCompletedAt
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
			contentReplayUpperAt: string | null
			contentReplayCursorUpdatedAt: string | null
			contentReplayCursorId: string | null
			messageCursorCreatedAt: string | null
			messageCursorId: string | null
			messagesCompletedAt: string | null
			eventCursorCreatedAt: string | null
			eventCursorId: string | null
			eventsCompletedAt: string | null
		}>()
	if (!row) return null
	const messageCursor =
		row.messageCursorCreatedAt != null && row.messageCursorId != null
			? { createdAt: row.messageCursorCreatedAt, id: row.messageCursorId }
			: null
	const eventCursor =
		row.eventCursorCreatedAt != null && row.eventCursorId != null
			? { createdAt: row.eventCursorCreatedAt, id: row.eventCursorId }
			: null
	const contentReplayCursor =
		row.contentReplayCursorUpdatedAt != null &&
		row.contentReplayCursorId != null
			? {
					updatedAt: row.contentReplayCursorUpdatedAt,
					id: row.contentReplayCursorId,
				}
			: null
	return {
		userId: row.userId,
		matchingSince: row.matchingSince,
		mismatchCount: Number(row.mismatchCount ?? 0) || 0,
		contentWatermarkAt: row.contentWatermarkAt,
		contentReplayUpperAt: row.contentReplayUpperAt,
		contentReplayCursor,
		messageCursor,
		messagesCompletedAt: row.messagesCompletedAt,
		eventCursor,
		eventsCompletedAt: row.eventsCompletedAt,
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
 * Owner-scoped delivery-event creation keyset (all rows, including those bound
 * to messages). Repairs events omitted by per-message graph truncation.
 */
export async function listEventBackfillPage(input: {
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
 * Keyset page within a frozen content-replay window (watermark, upper].
 * In-tick / durable `cursor` continues without skipping equal `updated_at`.
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
	contentReplayUpperAt: string | null
	contentReplayCursor: MailboxParityContentCursor | null
	messageCursor: MailboxParityBackfillCursor | null
	messagesCompletedAt: string | null
	eventCursor: MailboxParityBackfillCursor | null
	eventsCompletedAt: string | null
	lastError: string | null
}): Promise<{ wrote: boolean }> {
	const result = await input.db
		.prepare(
			`UPDATE users
			SET mailbox_parity_checked_at = ?,
				mailbox_parity_matching_since = ?,
				mailbox_parity_mismatch_count = ?,
				mailbox_parity_last_error = ?,
				mailbox_parity_content_watermark_at = ?,
				mailbox_parity_content_replay_upper_at = ?,
				mailbox_parity_content_replay_cursor_updated_at = ?,
				mailbox_parity_content_replay_cursor_id = ?,
				mailbox_parity_message_backfill_cursor_created_at = ?,
				mailbox_parity_message_backfill_cursor_id = ?,
				mailbox_parity_message_backfill_completed_at = ?,
				mailbox_parity_event_backfill_cursor_created_at = ?,
				mailbox_parity_event_backfill_cursor_id = ?,
				mailbox_parity_event_backfill_completed_at = ?
			WHERE stable_user_id = ?
				AND deleting_at IS NULL`,
		)
		.bind(
			input.nowIso,
			input.matchingSince,
			input.mismatchCount,
			input.lastError,
			input.contentWatermarkAt,
			input.contentReplayUpperAt,
			input.contentReplayCursor?.updatedAt ?? null,
			input.contentReplayCursor?.id ?? null,
			input.messageCursor?.createdAt ?? null,
			input.messageCursor?.id ?? null,
			input.messagesCompletedAt,
			input.eventCursor?.createdAt ?? null,
			input.eventCursor?.id ?? null,
			input.eventsCompletedAt,
			input.userId,
		)
		.run()
	return { wrote: (result.meta?.changes ?? 0) > 0 }
}

export async function rotateCheckedAt(input: {
	db: D1Database
	userId: string
	nowIso: string
	lastError: string | null
}): Promise<{ wrote: boolean }> {
	// Clears matching_since so a poison/error tick cannot preserve a false soak.
	const result = await input.db
		.prepare(
			`UPDATE users
			SET mailbox_parity_checked_at = ?,
				mailbox_parity_last_error = ?,
				mailbox_parity_matching_since = NULL
			WHERE stable_user_id = ?
				AND deleting_at IS NULL`,
		)
		.bind(input.nowIso, input.lastError, input.userId)
		.run()
	return { wrote: (result.meta?.changes ?? 0) > 0 }
}
