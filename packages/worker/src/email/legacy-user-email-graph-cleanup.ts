import { runD1WithRetry } from '#worker/d1-retry.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { markedUserEmailD1Database } from './user-email-d1-guard.ts'

export const frozenUserEmailDeliveryEventRetentionDays = 90
export const frozenUserEmailMessageRetentionDays = 365
export const frozenUserEmailGraphCleanupBatchSize = 250

const millisecondsPerDay = 24 * 60 * 60 * 1000

function retentionCutoff(now: Date, days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

function placeholders(values: ReadonlyArray<unknown>) {
	return values.map(() => '?').join(', ')
}

/**
 * Privacy-only account deletion for the frozen pre-cutover USER graph.
 *
 * This is deliberately separate from live email repositories. It is the only
 * per-owner mutation allowed against the four shared graph tables after
 * cutover, runs after authoritative Mailbox/R2 cleanup, and never exports or
 * returns message content.
 */
export async function deleteFrozenUserEmailGraphForAccount(input: {
	db: D1Database
	userId: string
}): Promise<Record<string, number>> {
	if (input.userId === systemEmailOwnerId) {
		throw new Error('The system email graph is not USER privacy cleanup.')
	}
	const db = markedUserEmailD1Database(input.db, 'frozen-privacy-cleanup')
	const results = await db.batch([
		db
			.prepare(
				`DELETE FROM email_delivery_events
				WHERE user_id = ?`,
			)
			.bind(input.userId),
		db
			.prepare(
				`DELETE FROM email_attachments
				WHERE message_id IN (
					SELECT id FROM email_messages WHERE user_id = ?
				)`,
			)
			.bind(input.userId),
		db
			.prepare(
				`DELETE FROM email_messages
				WHERE user_id = ?`,
			)
			.bind(input.userId),
		db
			.prepare(
				`DELETE FROM email_threads
				WHERE user_id = ?`,
			)
			.bind(input.userId),
	])
	return {
		email_delivery_events: Number(results[0]?.meta.changes ?? 0),
		email_attachments: Number(results[1]?.meta.changes ?? 0),
		email_messages: Number(results[2]?.meta.changes ?? 0),
		email_threads: Number(results[3]?.meta.changes ?? 0),
	}
}

export type FrozenUserEmailGraphRetentionResult = {
	emailDeliveryEvents: number
	emailMessages: number
	emailAttachments: number
	emailThreads: number
	selectedMessages: number
	hasMore: boolean
}

/**
 * Metadata-only retention for the frozen rollback snapshot. R2 belongs to the
 * Mailbox authority and is never touched from legacy rows. Indexed outbound
 * messages are skipped so the migration-0132 compatibility trigger cannot
 * erase the live provider reverse lookup.
 */
export async function pruneFrozenUserEmailGraphForRetention(input: {
	db: D1Database
	now?: Date
	batchSize?: number
}): Promise<FrozenUserEmailGraphRetentionResult> {
	const now = input.now ?? new Date()
	const db = markedUserEmailD1Database(input.db, 'frozen-privacy-cleanup')
	const batchSize = input.batchSize ?? frozenUserEmailGraphCleanupBatchSize
	const eventCutoff = retentionCutoff(
		now,
		frozenUserEmailDeliveryEventRetentionDays,
	)
	const messageCutoff = retentionCutoff(
		now,
		frozenUserEmailMessageRetentionDays,
	)
	const eventRows = await runD1WithRetry(() =>
		db
			.prepare(
				`SELECT id
				FROM email_delivery_events
				WHERE user_id != ?
					AND created_at < ?
				ORDER BY created_at ASC, id ASC
				LIMIT ?`,
			)
			.bind(systemEmailOwnerId, eventCutoff, batchSize)
			.all<{ id: string }>(),
	)
	const eventIds = (eventRows.results ?? []).map((row) => row.id)
	let emailDeliveryEvents = 0
	if (eventIds.length > 0) {
		const result = await runD1WithRetry(() =>
			db
				.prepare(
					`DELETE FROM email_delivery_events
					WHERE id IN (${placeholders(eventIds)})
						AND user_id != ?`,
				)
				.bind(...eventIds, systemEmailOwnerId)
				.run(),
		)
		emailDeliveryEvents = Number(result.meta.changes ?? 0)
	}

	const messageRows = await runD1WithRetry(() =>
		db
			.prepare(
				`SELECT message.id, message.user_id
				FROM email_messages AS message
				WHERE message.user_id != ?
					AND message.created_at < ?
					AND NOT EXISTS (
						SELECT 1
						FROM email_outbound_provider_index AS provider_index
						WHERE provider_index.message_id = message.id
					)
				ORDER BY message.created_at ASC, message.id ASC
				LIMIT ?`,
			)
			.bind(systemEmailOwnerId, messageCutoff, batchSize)
			.all<{ id: string; user_id: string }>(),
	)
	const messageIds = (messageRows.results ?? []).map((row) => row.id)
	const affectedOwners = [
		...new Set((messageRows.results ?? []).map((row) => row.user_id)),
	]
	let emailAttachments = 0
	let emailMessages = 0
	if (messageIds.length > 0) {
		const ids = placeholders(messageIds)
		const results = await db.batch([
			db
				.prepare(
					`DELETE FROM email_attachments
					WHERE message_id IN (${ids})`,
				)
				.bind(...messageIds),
			db
				.prepare(
					`DELETE FROM email_messages
					WHERE id IN (${ids})
						AND user_id != ?
						AND NOT EXISTS (
							SELECT 1
							FROM email_outbound_provider_index AS provider_index
							WHERE provider_index.message_id = email_messages.id
						)`,
				)
				.bind(...messageIds, systemEmailOwnerId),
		])
		emailAttachments = Number(results[0]?.meta.changes ?? 0)
		emailMessages = Number(results[1]?.meta.changes ?? 0)
	}

	let emailThreads = 0
	if (affectedOwners.length > 0) {
		const result = await runD1WithRetry(() =>
			db
				.prepare(
					`DELETE FROM email_threads
					WHERE user_id IN (${placeholders(affectedOwners)})
						AND user_id != ?
						AND NOT EXISTS (
							SELECT 1
							FROM email_messages
							WHERE email_messages.thread_id = email_threads.id
						)`,
				)
				.bind(...affectedOwners, systemEmailOwnerId)
				.run(),
		)
		emailThreads = Number(result.meta.changes ?? 0)
	}

	return {
		emailDeliveryEvents,
		emailMessages,
		emailAttachments,
		emailThreads,
		selectedMessages: messageIds.length,
		hasMore: eventIds.length >= batchSize || messageIds.length >= batchSize,
	}
}

/**
 * Aggregate-only backup verification. This is the sole allowed post-cutover
 * read of frozen USER graph rows and must never be imported by live flows.
 */
export async function loadFrozenUserEmailGraphBackupAudit(input: {
	db: D1Database
}): Promise<{
	owners: number
	threads: number
	messages: number
	attachments: number
	deliveryEvents: number
}> {
	const db = markedUserEmailD1Database(input.db, 'frozen-backup-audit')
	const row = await db
		.prepare(
			`SELECT
				(
					SELECT COUNT(DISTINCT user_id)
					FROM (
						SELECT user_id FROM email_threads WHERE user_id != ?
						UNION
						SELECT user_id FROM email_messages WHERE user_id != ?
						UNION
						SELECT user_id FROM email_delivery_events WHERE user_id != ?
					)
				) AS owners,
				(SELECT COUNT(*) FROM email_threads WHERE user_id != ?) AS threads,
				(SELECT COUNT(*) FROM email_messages WHERE user_id != ?) AS messages,
				(
					SELECT COUNT(*)
					FROM email_attachments AS attachment
					JOIN email_messages AS message ON message.id = attachment.message_id
					WHERE message.user_id != ?
				) AS attachments,
				(
					SELECT COUNT(*)
					FROM email_delivery_events
					WHERE user_id != ?
				) AS delivery_events`,
		)
		.bind(
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
			systemEmailOwnerId,
		)
		.first<{
			owners: number
			threads: number
			messages: number
			attachments: number
			delivery_events: number
		}>()
	return {
		owners: Number(row?.owners ?? 0),
		threads: Number(row?.threads ?? 0),
		messages: Number(row?.messages ?? 0),
		attachments: Number(row?.attachments ?? 0),
		deliveryEvents: Number(row?.delivery_events ?? 0),
	}
}
