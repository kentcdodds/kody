/**
 * Derived D1 reverse index: outbound provider message id → owning message.
 * `email_messages.provider_message_id` stays authoritative; this table exists
 * so contextless provider webhooks resolve owner/message without scanning the
 * full messages table or enumerating Mailbox objects.
 */

export const emailOutboundProviderCloudflare = 'cloudflare-email'

export type EmailOutboundProviderIndexRow = {
	provider: string
	providerMessageId: string
	userId: string
	messageId: string
	inboxId: string | null
	createdAt: string
	updatedAt: string
}

export type OutboundProviderIndexParityReport = {
	linkedMessageCount: number
	indexCount: number
	missingFromIndexCount: number
	missingFromMessagesCount: number
	mismatchedCount: number
	parity: boolean
}

export function classifyOutboundProviderIndexParity(
	counts: Omit<OutboundProviderIndexParityReport, 'parity'>,
): OutboundProviderIndexParityReport {
	return {
		...counts,
		parity:
			counts.linkedMessageCount === counts.indexCount &&
			counts.missingFromIndexCount === 0 &&
			counts.missingFromMessagesCount === 0 &&
			counts.mismatchedCount === 0,
	}
}

function mapIndexRow(
	row: Record<string, unknown>,
): EmailOutboundProviderIndexRow {
	return {
		provider: String(row['provider']),
		providerMessageId: String(row['provider_message_id']),
		userId: String(row['user_id']),
		messageId: String(row['message_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export async function getOutboundProviderIndexRow(input: {
	db: D1Database
	provider?: string
	providerMessageId: string
}): Promise<EmailOutboundProviderIndexRow | null> {
	const provider = input.provider ?? emailOutboundProviderCloudflare
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_outbound_provider_index
			WHERE provider = ?
				AND provider_message_id = ?
			LIMIT 1`,
		)
		.bind(provider, input.providerMessageId)
		.first<Record<string, unknown>>()
	return row ? mapIndexRow(row) : null
}

/**
 * Prepared statements that sync the derived index from the authoritative
 * `email_messages` row. Callers must include these in the same `db.batch` as
 * the message INSERT/UPDATE so message + index commit atomically. Owner and
 * inbox fields always come from the message row — never from caller input.
 */
export function prepareOutboundProviderIndexSyncStatements(input: {
	db: D1Database
	messageId: string
	/**
	 * Target provider id after the accompanying message mutation. Null/empty
	 * clears every index row for `messageId`.
	 */
	providerMessageId: string | null
	provider?: string
	now: string
}): Array<D1PreparedStatement> {
	const provider = input.provider ?? emailOutboundProviderCloudflare
	const providerMessageId = input.providerMessageId
	if (providerMessageId == null || providerMessageId === '') {
		return [
			input.db
				.prepare(
					`DELETE FROM email_outbound_provider_index
					WHERE message_id = ?`,
				)
				.bind(input.messageId),
		]
	}
	return [
		input.db
			.prepare(
				`DELETE FROM email_outbound_provider_index
				WHERE message_id = ?
					AND NOT (provider = ? AND provider_message_id = ?)`,
			)
			.bind(input.messageId, provider, providerMessageId),
		input.db
			.prepare(
				`INSERT INTO email_outbound_provider_index (
					provider, provider_message_id, user_id, message_id, inbox_id,
					created_at, updated_at
				)
				SELECT
					?,
					message.provider_message_id,
					message.user_id,
					message.id,
					message.inbox_id,
					?,
					?
				FROM email_messages AS message
				WHERE message.id = ?
					AND message.direction = 'outbound'
					AND message.provider_message_id = ?
				ON CONFLICT(provider, provider_message_id) DO UPDATE SET
					user_id = excluded.user_id,
					message_id = excluded.message_id,
					inbox_id = excluded.inbox_id,
					updated_at = excluded.updated_at`,
			)
			.bind(provider, input.now, input.now, input.messageId, providerMessageId),
	]
}

export async function deleteOutboundProviderIndexByMessageId(input: {
	db: D1Database
	messageId: string
}): Promise<number> {
	const result = await input.db
		.prepare(
			`DELETE FROM email_outbound_provider_index
			WHERE message_id = ?`,
		)
		.bind(input.messageId)
		.run()
	return Number(result.meta.changes ?? 0)
}

export async function deleteOutboundProviderIndexByMessageIds(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
}): Promise<number> {
	if (input.messageIds.length === 0) return 0
	let deleted = 0
	const chunkSize = 100
	for (let index = 0; index < input.messageIds.length; index += chunkSize) {
		const chunk = input.messageIds.slice(index, index + chunkSize)
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await input.db
			.prepare(
				`DELETE FROM email_outbound_provider_index
				WHERE message_id IN (${placeholders})`,
			)
			.bind(...chunk)
			.run()
		deleted += Number(result.meta.changes ?? 0)
	}
	return deleted
}

/**
 * Read-only aggregate compare of outbound messages that carry a provider id
 * versus the derived reverse index. Optional `userId` scopes the report
 * (including `system:email`). No message content is returned.
 */
export async function loadOutboundProviderIndexParityReport(input: {
	db: D1Database
	userId?: string
}): Promise<OutboundProviderIndexParityReport> {
	const userId = input.userId ?? null
	const row = await input.db
		.prepare(
			`WITH
				linked_messages AS (
					SELECT
						message.id AS message_id,
						message.user_id AS user_id,
						message.inbox_id AS inbox_id,
						message.provider_message_id AS provider_message_id
					FROM email_messages AS message
					WHERE message.direction = 'outbound'
						AND message.provider_message_id IS NOT NULL
						AND (?1 IS NULL OR message.user_id = ?1)
				),
				index_rows AS (
					SELECT
						idx.provider AS provider,
						idx.provider_message_id AS provider_message_id,
						idx.user_id AS user_id,
						idx.message_id AS message_id,
						idx.inbox_id AS inbox_id
					FROM email_outbound_provider_index AS idx
					WHERE ?1 IS NULL OR idx.user_id = ?1
				),
				classified AS (
					SELECT
						(SELECT COUNT(*) FROM linked_messages) AS linked_message_count,
						(SELECT COUNT(*) FROM index_rows) AS index_count,
						(
							SELECT COUNT(*)
							FROM linked_messages AS message
							WHERE NOT EXISTS (
								SELECT 1
								FROM index_rows AS idx
								WHERE idx.provider = ?2
									AND idx.provider_message_id = message.provider_message_id
									AND idx.message_id = message.message_id
									AND idx.user_id = message.user_id
									AND IFNULL(idx.inbox_id, '') = IFNULL(message.inbox_id, '')
							)
						) AS missing_from_index_count,
						(
							SELECT COUNT(*)
							FROM index_rows AS idx
							WHERE NOT EXISTS (
								SELECT 1
								FROM linked_messages AS message
								WHERE message.message_id = idx.message_id
									AND message.user_id = idx.user_id
									AND message.provider_message_id = idx.provider_message_id
							)
						) AS missing_from_messages_count,
						(
							SELECT COUNT(*)
							FROM index_rows AS idx
							JOIN email_messages AS message
								ON message.id = idx.message_id
							WHERE (?1 IS NULL OR idx.user_id = ?1)
								AND (
									message.user_id != idx.user_id
									OR message.direction != 'outbound'
									OR message.provider_message_id IS NULL
									OR message.provider_message_id != idx.provider_message_id
									OR IFNULL(message.inbox_id, '') != IFNULL(idx.inbox_id, '')
								)
						) AS mismatched_count
				)
			SELECT
				linked_message_count,
				index_count,
				missing_from_index_count,
				missing_from_messages_count,
				mismatched_count
			FROM classified`,
		)
		.bind(userId, emailOutboundProviderCloudflare)
		.first<{
			linked_message_count: number
			index_count: number
			missing_from_index_count: number
			missing_from_messages_count: number
			mismatched_count: number
		}>()

	const linkedMessageCount = Number(row?.linked_message_count ?? 0)
	const indexCount = Number(row?.index_count ?? 0)
	const missingFromIndexCount = Number(row?.missing_from_index_count ?? 0)
	const missingFromMessagesCount = Number(row?.missing_from_messages_count ?? 0)
	const mismatchedCount = Number(row?.mismatched_count ?? 0)
	return classifyOutboundProviderIndexParity({
		linkedMessageCount,
		indexCount,
		missingFromIndexCount,
		missingFromMessagesCount,
		mismatchedCount,
	})
}
