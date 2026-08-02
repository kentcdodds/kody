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
 * Upsert the derived index for one outbound message. Callers must write the
 * authoritative `email_messages` row first. Replaces any prior mapping for the
 * same `message_id` when the provider id changes.
 */
export async function upsertOutboundProviderIndex(input: {
	db: D1Database
	provider?: string
	providerMessageId: string
	userId: string
	messageId: string
	inboxId?: string | null
	now?: string
}): Promise<void> {
	const provider = input.provider ?? emailOutboundProviderCloudflare
	const now = input.now ?? new Date().toISOString()
	await input.db.batch([
		input.db
			.prepare(
				`DELETE FROM email_outbound_provider_index
				WHERE message_id = ?
					AND NOT (provider = ? AND provider_message_id = ?)`,
			)
			.bind(input.messageId, provider, input.providerMessageId),
		input.db
			.prepare(
				`INSERT INTO email_outbound_provider_index (
					provider, provider_message_id, user_id, message_id, inbox_id,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(provider, provider_message_id) DO UPDATE SET
					user_id = excluded.user_id,
					message_id = excluded.message_id,
					inbox_id = excluded.inbox_id,
					updated_at = excluded.updated_at`,
			)
			.bind(
				provider,
				input.providerMessageId,
				input.userId,
				input.messageId,
				input.inboxId ?? null,
				now,
				now,
			),
	])
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

export type OutboundProviderIndexParityMismatch = {
	kind: 'missing_from_index' | 'missing_from_messages' | 'mismatched'
	provider: string
	providerMessageId: string
	userId: string
	messageId: string
	detail: string
}

export type OutboundProviderIndexParityReport = {
	linkedMessageCount: number
	indexCount: number
	missingFromIndexCount: number
	missingFromMessagesCount: number
	mismatchedCount: number
	sampleMismatches: Array<OutboundProviderIndexParityMismatch>
	parity: boolean
}

/**
 * Read-only compare of outbound messages that carry a provider id versus the
 * derived reverse index. Optional `userId` scopes the report to one owner
 * (including `system:email`).
 */
export async function loadOutboundProviderIndexParityReport(input: {
	db: D1Database
	userId?: string
	sampleLimit?: number
}): Promise<OutboundProviderIndexParityReport> {
	const sampleLimit = input.sampleLimit ?? 20
	const userFilter = input.userId == null ? '' : ' AND user_id = ?'
	const userBindings = input.userId == null ? [] : [input.userId]

	const linkedMessageCount = Number(
		(
			await input.db
				.prepare(
					`SELECT COUNT(*) AS count
					FROM email_messages
					WHERE direction = 'outbound'
						AND provider_message_id IS NOT NULL${userFilter}`,
				)
				.bind(...userBindings)
				.first<{ count: number }>()
		)?.count ?? 0,
	)
	const indexCount = Number(
		(
			await input.db
				.prepare(
					`SELECT COUNT(*) AS count
					FROM email_outbound_provider_index
					WHERE 1 = 1${userFilter}`,
				)
				.bind(...userBindings)
				.first<{ count: number }>()
		)?.count ?? 0,
	)

	const missingFromIndexRows = await input.db
		.prepare(
			`SELECT
				message.id AS message_id,
				message.user_id AS user_id,
				message.provider_message_id AS provider_message_id
			FROM email_messages AS message
			WHERE message.direction = 'outbound'
				AND message.provider_message_id IS NOT NULL${
					input.userId == null ? '' : ' AND message.user_id = ?'
				}
				AND NOT EXISTS (
					SELECT 1
					FROM email_outbound_provider_index AS idx
					WHERE idx.provider = ?
						AND idx.provider_message_id = message.provider_message_id
						AND idx.message_id = message.id
						AND idx.user_id = message.user_id
				)
			ORDER BY message.created_at ASC, message.id ASC
			LIMIT ?`,
		)
		.bind(
			...(input.userId == null ? [] : [input.userId]),
			emailOutboundProviderCloudflare,
			sampleLimit,
		)
		.all<{
			message_id: string
			user_id: string
			provider_message_id: string
		}>()

	const missingFromMessagesRows = await input.db
		.prepare(
			`SELECT
				idx.provider AS provider,
				idx.provider_message_id AS provider_message_id,
				idx.user_id AS user_id,
				idx.message_id AS message_id
			FROM email_outbound_provider_index AS idx
			WHERE 1 = 1${input.userId == null ? '' : ' AND idx.user_id = ?'}
				AND NOT EXISTS (
					SELECT 1
					FROM email_messages AS message
					WHERE message.id = idx.message_id
						AND message.user_id = idx.user_id
						AND message.direction = 'outbound'
						AND message.provider_message_id = idx.provider_message_id
				)
			ORDER BY idx.created_at ASC, idx.message_id ASC
			LIMIT ?`,
		)
		.bind(...(input.userId == null ? [] : [input.userId]), sampleLimit)
		.all<{
			provider: string
			provider_message_id: string
			user_id: string
			message_id: string
		}>()

	const mismatchedRows = await input.db
		.prepare(
			`SELECT
				idx.provider AS provider,
				idx.provider_message_id AS provider_message_id,
				idx.user_id AS index_user_id,
				idx.message_id AS message_id,
				message.user_id AS message_user_id,
				message.provider_message_id AS message_provider_message_id,
				message.inbox_id AS message_inbox_id,
				idx.inbox_id AS index_inbox_id
			FROM email_outbound_provider_index AS idx
			JOIN email_messages AS message
				ON message.id = idx.message_id
			WHERE 1 = 1${input.userId == null ? '' : ' AND idx.user_id = ?'}
				AND (
					message.user_id != idx.user_id
					OR message.direction != 'outbound'
					OR message.provider_message_id IS NULL
					OR message.provider_message_id != idx.provider_message_id
					OR IFNULL(message.inbox_id, '') != IFNULL(idx.inbox_id, '')
				)
			ORDER BY idx.created_at ASC, idx.message_id ASC
			LIMIT ?`,
		)
		.bind(...(input.userId == null ? [] : [input.userId]), sampleLimit)
		.all<{
			provider: string
			provider_message_id: string
			index_user_id: string
			message_id: string
			message_user_id: string
			message_provider_message_id: string | null
			message_inbox_id: string | null
			index_inbox_id: string | null
		}>()

	const missingFromIndexCount = Number(
		(
			await input.db
				.prepare(
					`SELECT COUNT(*) AS count
					FROM email_messages AS message
					WHERE message.direction = 'outbound'
						AND message.provider_message_id IS NOT NULL${
							input.userId == null ? '' : ' AND message.user_id = ?'
						}
						AND NOT EXISTS (
							SELECT 1
							FROM email_outbound_provider_index AS idx
							WHERE idx.provider = ?
								AND idx.provider_message_id = message.provider_message_id
								AND idx.message_id = message.id
								AND idx.user_id = message.user_id
						)`,
				)
				.bind(
					...(input.userId == null ? [] : [input.userId]),
					emailOutboundProviderCloudflare,
				)
				.first<{ count: number }>()
		)?.count ?? 0,
	)
	const missingFromMessagesCount = Number(
		(
			await input.db
				.prepare(
					`SELECT COUNT(*) AS count
					FROM email_outbound_provider_index AS idx
					WHERE 1 = 1${input.userId == null ? '' : ' AND idx.user_id = ?'}
						AND NOT EXISTS (
							SELECT 1
							FROM email_messages AS message
							WHERE message.id = idx.message_id
								AND message.user_id = idx.user_id
								AND message.direction = 'outbound'
								AND message.provider_message_id = idx.provider_message_id
						)`,
				)
				.bind(...(input.userId == null ? [] : [input.userId]))
				.first<{ count: number }>()
		)?.count ?? 0,
	)
	const mismatchedCount = Number(
		(
			await input.db
				.prepare(
					`SELECT COUNT(*) AS count
					FROM email_outbound_provider_index AS idx
					JOIN email_messages AS message
						ON message.id = idx.message_id
					WHERE 1 = 1${input.userId == null ? '' : ' AND idx.user_id = ?'}
						AND (
							message.user_id != idx.user_id
							OR message.direction != 'outbound'
							OR message.provider_message_id IS NULL
							OR message.provider_message_id != idx.provider_message_id
							OR IFNULL(message.inbox_id, '') != IFNULL(idx.inbox_id, '')
						)`,
				)
				.bind(...(input.userId == null ? [] : [input.userId]))
				.first<{ count: number }>()
		)?.count ?? 0,
	)

	const sampleMismatches: Array<OutboundProviderIndexParityMismatch> = [
		...(missingFromIndexRows.results ?? []).map((row) => ({
			kind: 'missing_from_index' as const,
			provider: emailOutboundProviderCloudflare,
			providerMessageId: row.provider_message_id,
			userId: row.user_id,
			messageId: row.message_id,
			detail: 'Linked outbound message has no matching index row.',
		})),
		...(missingFromMessagesRows.results ?? []).map((row) => ({
			kind: 'missing_from_messages' as const,
			provider: row.provider,
			providerMessageId: row.provider_message_id,
			userId: row.user_id,
			messageId: row.message_id,
			detail: 'Index row has no matching linked outbound message.',
		})),
		...(mismatchedRows.results ?? []).map((row) => ({
			kind: 'mismatched' as const,
			provider: row.provider,
			providerMessageId: row.provider_message_id,
			userId: row.index_user_id,
			messageId: row.message_id,
			detail: `Index/message fields diverge (message user=${row.message_user_id}, provider_message_id=${row.message_provider_message_id ?? 'null'}, inbox=${row.message_inbox_id ?? 'null'} vs index inbox=${row.index_inbox_id ?? 'null'}).`,
		})),
	].slice(0, sampleLimit)

	return {
		linkedMessageCount,
		indexCount,
		missingFromIndexCount,
		missingFromMessagesCount,
		mismatchedCount,
		sampleMismatches,
		parity:
			linkedMessageCount === indexCount &&
			missingFromIndexCount === 0 &&
			missingFromMessagesCount === 0 &&
			mismatchedCount === 0,
	}
}
