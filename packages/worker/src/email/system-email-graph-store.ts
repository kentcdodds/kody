import {
	boundedEmailBody,
	emailRawMimeKey,
	mapAttachmentRow,
	mapMessageRow,
	mapThreadRow,
	type DeleteEmailMessageByIdResult,
	type EmailInboundDeliveryFence,
} from './repo.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailMessageRecord,
	type EmailProcessingStatus,
	type EmailThreadRecord,
} from './types.ts'

function nowIso() {
	return new Date().toISOString()
}

function messageSelect(columns = 'message.*') {
	return `SELECT ${columns}, '${systemEmailOwnerId}' AS user_id
		FROM system_email_messages AS message`
}

function threadRecord(row: Record<string, unknown>): EmailThreadRecord {
	return mapThreadRow({ ...row, user_id: systemEmailOwnerId })
}

function messageRecord(row: Record<string, unknown>): EmailMessageRecord {
	return mapMessageRow({ ...row, user_id: systemEmailOwnerId })
}

export async function getSystemEmailMessageById(input: {
	db: D1Database
	messageId: string
}) {
	const row = await input.db
		.prepare(
			`${messageSelect()}
			WHERE message.id = ?
			LIMIT 1`,
		)
		.bind(input.messageId)
		.first<Record<string, unknown>>()
	return row ? messageRecord(row) : null
}

export async function countSystemEmailMessages(input: {
	db: D1Database
	direction?: 'inbound' | 'outbound'
}) {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM system_email_messages
			WHERE (? IS NULL OR direction = ?)`,
		)
		.bind(input.direction ?? null, input.direction ?? null)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function listSystemEmailMessages(input: {
	db: D1Database
	inboxId?: string | null
	classification?: EmailClassification | null
	limit: number
}) {
	const result = await input.db
		.prepare(
			`${messageSelect()}
			WHERE (? IS NULL OR message.inbox_id = ?)
				AND (? IS NULL OR message.classification = ?)
			ORDER BY message.created_at DESC, message.id DESC
			LIMIT ?`,
		)
		.bind(
			input.inboxId ?? null,
			input.inboxId ?? null,
			input.classification ?? null,
			input.classification ?? null,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(messageRecord)
}

export async function findSystemEmailThreadForInboundMessage(input: {
	db: D1Database
	inboxId?: string | null
	references: Array<string>
	inReplyToHeader?: string | null
}) {
	const ids = [
		...input.references,
		...(input.inReplyToHeader ? [input.inReplyToHeader] : []),
	].filter(Boolean)
	for (const id of ids) {
		const row = await input.db
			.prepare(
				`SELECT thread.*, '${systemEmailOwnerId}' AS user_id
				FROM system_email_threads thread
				JOIN system_email_messages message ON message.thread_id = thread.id
				WHERE (? IS NULL OR thread.inbox_id = ?)
					AND message.message_id_header = ?
				LIMIT 1`,
			)
			.bind(input.inboxId ?? null, input.inboxId ?? null, id)
			.first<Record<string, unknown>>()
		if (row) return threadRecord(row)
	}
	return null
}

export async function createSystemEmailThread(input: {
	db: D1Database
	id?: string
	inboxId?: string | null
	subjectNormalized?: string | null
	rootMessageIdHeader?: string | null
	lastMessageAt?: string | null
	ignoreConflict?: boolean
	inboundDeliveryFence?: EmailInboundDeliveryFence
}) {
	const timestamp = nowIso()
	const row = {
		id: input.id ?? crypto.randomUUID(),
		inbox_id: input.inboxId ?? null,
		subject_normalized: input.subjectNormalized ?? '',
		root_message_id_header: input.rootMessageIdHeader ?? null,
		last_message_at: input.lastMessageAt ?? timestamp,
		created_at: timestamp,
		updated_at: timestamp,
	}
	const values = [
		row.id,
		row.inbox_id,
		row.subject_normalized,
		row.root_message_id_header,
		row.last_message_at,
		row.created_at,
		row.updated_at,
	]
	const fence = input.inboundDeliveryFence
	const prefix = input.ignoreConflict ? 'INSERT OR IGNORE' : 'INSERT'
	const dedicated = input.db
		.prepare(
			`${prefix} INTO system_email_threads (
				id, inbox_id, subject_normalized, root_message_id_header,
				last_message_at, created_at, updated_at
			) ${
				fence
					? `SELECT ?, ?, ?, ?, ?, ?, ?
						WHERE EXISTS (
							SELECT 1 FROM system_email_delivery_events
							WHERE id = ?
								AND state = 'storing'
								AND storage_lease = ?
						)`
					: 'VALUES (?, ?, ?, ?, ?, ?, ?)'
			}`,
		)
		.bind(...values, ...(fence ? [fence.deliveryId, fence.storageLease] : []))
	const legacy = input.db
		.prepare(
			`${prefix} INTO email_threads (
				id, user_id, inbox_id, subject_normalized, root_message_id_header,
				last_message_at, created_at, updated_at
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?
			WHERE ${
				fence
					? `EXISTS (
							SELECT 1 FROM system_email_delivery_events
							WHERE id = ? AND state = 'storing' AND storage_lease = ?
						)`
					: '1'
			}`,
		)
		.bind(
			row.id,
			systemEmailOwnerId,
			...values.slice(1),
			...(fence ? [fence.deliveryId, fence.storageLease] : []),
		)
	await input.db.batch([dedicated, legacy])
	return threadRecord(row)
}

type SystemMessageInput = {
	id?: string
	direction: 'inbound' | 'outbound'
	userId: string
	inboxId?: string | null
	threadId?: string | null
	senderIdentityId?: string | null
	fromAddress?: string | null
	envelopeFrom?: string | null
	toAddresses?: Array<unknown>
	ccAddresses?: Array<unknown>
	bccAddresses?: Array<unknown>
	replyToAddresses?: Array<unknown>
	subject?: string | null
	messageIdHeader?: string | null
	inReplyToHeader?: string | null
	references?: Array<string>
	headers?: Record<string, unknown> | null
	authResults?: string | null
	textBody?: string | null
	htmlBody?: string | null
	rawMimeKey?: string | null
	rawSize?: number | null
	processingStatus: EmailProcessingStatus
	classification?: EmailClassification
	classificationReason?: string | null
	providerMessageId?: string | null
	error?: string | null
	receivedAt?: string | null
	sentAt?: string | null
}

export async function insertSystemEmailMessage(input: {
	db: D1Database
	inboundDeliveryFence?: EmailInboundDeliveryFence
	message: SystemMessageInput
}) {
	if (input.message.userId !== systemEmailOwnerId) {
		throw new Error('System email graph writes require system:email.')
	}
	if (
		input.message.direction !== 'inbound' ||
		input.message.providerMessageId != null
	) {
		throw new Error(
			'System outbound email is unsupported by the dedicated graph.',
		)
	}
	const timestamp = nowIso()
	const row = {
		id: input.message.id ?? crypto.randomUUID(),
		direction: input.message.direction,
		inbox_id: input.message.inboxId ?? null,
		thread_id: input.message.threadId ?? null,
		sender_identity_id: input.message.senderIdentityId ?? null,
		from_address: input.message.fromAddress ?? '',
		envelope_from: input.message.envelopeFrom ?? null,
		to_addresses_json: JSON.stringify(input.message.toAddresses ?? []),
		cc_addresses_json: JSON.stringify(input.message.ccAddresses ?? []),
		bcc_addresses_json: JSON.stringify(input.message.bccAddresses ?? []),
		reply_to_addresses_json: JSON.stringify(
			input.message.replyToAddresses ?? [],
		),
		subject: input.message.subject ?? '',
		message_id_header: input.message.messageIdHeader ?? null,
		in_reply_to_header: input.message.inReplyToHeader ?? null,
		references_json: JSON.stringify(input.message.references ?? []),
		headers_json: input.message.headers
			? JSON.stringify(input.message.headers)
			: '{}',
		auth_results: input.message.authResults ?? null,
		text_body: boundedEmailBody(input.message.textBody),
		html_body: boundedEmailBody(input.message.htmlBody),
		raw_size: input.message.rawSize ?? 0,
		processing_status: input.message.processingStatus,
		provider_message_id: null,
		error: input.message.error ?? null,
		received_at: input.message.receivedAt ?? null,
		sent_at: input.message.sentAt ?? null,
		created_at: timestamp,
		updated_at: timestamp,
		raw_mime_key: input.message.rawMimeKey ?? null,
		delivery_status: null,
		delivery_status_at: null,
		classification: input.message.classification ?? 'accepted',
		classification_reason: input.message.classificationReason ?? null,
	}
	const columns = [
		'id',
		'direction',
		'inbox_id',
		'thread_id',
		'sender_identity_id',
		'from_address',
		'envelope_from',
		'to_addresses_json',
		'cc_addresses_json',
		'bcc_addresses_json',
		'reply_to_addresses_json',
		'subject',
		'message_id_header',
		'in_reply_to_header',
		'references_json',
		'headers_json',
		'auth_results',
		'text_body',
		'html_body',
		'raw_size',
		'processing_status',
		'provider_message_id',
		'error',
		'received_at',
		'sent_at',
		'created_at',
		'updated_at',
		'raw_mime_key',
		'delivery_status',
		'delivery_status_at',
		'classification',
		'classification_reason',
	] as const
	const values = columns.map((column) => row[column])
	const placeholders = columns.map(() => '?').join(', ')
	const fence = input.inboundDeliveryFence
	const fenceSql = fence
		? `WHERE EXISTS (
				SELECT 1 FROM system_email_delivery_events
				WHERE id = ? AND state = 'storing' AND storage_lease = ?
			)`
		: ''
	const dedicated = input.db
		.prepare(
			`INSERT INTO system_email_messages (${columns.join(', ')})
			SELECT ${placeholders} ${fenceSql}`,
		)
		.bind(...values, ...(fence ? [fence.deliveryId, fence.storageLease] : []))
	const legacyColumns = [...columns.slice(0, 2), 'user_id', ...columns.slice(2)]
	const legacyValues = [
		row.id,
		row.direction,
		systemEmailOwnerId,
		...values.slice(2),
	]
	const legacy = input.db
		.prepare(
			`INSERT INTO email_messages (${legacyColumns.join(', ')})
			SELECT ${legacyColumns.map(() => '?').join(', ')} ${fenceSql}`,
		)
		.bind(
			...legacyValues,
			...(fence ? [fence.deliveryId, fence.storageLease] : []),
		)
	const results = await input.db.batch([dedicated, legacy])
	if (fence && Number(results[0]?.meta.changes ?? 0) === 0) {
		throw new Error(
			'Inbound delivery storage lease was lost before system message insert.',
		)
	}
	return messageRecord(row)
}

export async function insertSystemEmailAttachments(input: {
	db: D1Database
	messageId: string
	ignoreConflicts?: boolean
	inboundDeliveryFence?: EmailInboundDeliveryFence
	attachments: Array<{
		id?: string | null
		filename?: string | null
		contentType?: string | null
		contentId?: string | null
		disposition?: string | null
		size?: number | null
		storageKind: string
		storageKey?: string | null
	}>
}) {
	if (input.attachments.length === 0) return
	const timestamp = nowIso()
	const prefix = input.ignoreConflicts ? 'INSERT OR IGNORE' : 'INSERT'
	const fence = input.inboundDeliveryFence
	const fenceSql = fence
		? `WHERE EXISTS (
				SELECT 1 FROM system_email_delivery_events
				WHERE id = ? AND state = 'storing' AND storage_lease = ?
			)`
		: ''
	const statements: Array<D1PreparedStatement> = []
	for (const attachment of input.attachments) {
		const values = [
			attachment.id ?? crypto.randomUUID(),
			input.messageId,
			attachment.filename ?? null,
			attachment.contentType ?? null,
			attachment.contentId ?? null,
			attachment.disposition ?? null,
			attachment.size ?? 0,
			attachment.storageKind,
			attachment.storageKey ?? null,
			timestamp,
		]
		statements.push(
			input.db
				.prepare(
					`${prefix} INTO system_email_attachments (
						id, message_id, filename, content_type, content_id, disposition,
						size, storage_kind, storage_key, created_at
					) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${fenceSql}`,
				)
				.bind(
					...values,
					...(fence ? [fence.deliveryId, fence.storageLease] : []),
				),
			input.db
				.prepare(
					`${prefix} INTO email_attachments (
						id, message_id, filename, content_type, content_id, disposition,
						size, storage_kind, storage_key, created_at
					) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${fenceSql}`,
				)
				.bind(
					...values,
					...(fence ? [fence.deliveryId, fence.storageLease] : []),
				),
		)
	}
	await input.db.batch(statements)
}

export async function listSystemEmailAttachments(input: {
	db: D1Database
	messageId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM system_email_attachments
			WHERE message_id = ?
			ORDER BY created_at ASC, id ASC`,
		)
		.bind(input.messageId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapAttachmentRow)
}

export async function getSystemEmailAttachmentById(input: {
	db: D1Database
	attachmentId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT attachment.*
			FROM system_email_attachments attachment
			WHERE attachment.id = ?
			LIMIT 1`,
		)
		.bind(input.attachmentId)
		.first<Record<string, unknown>>()
	return row ? mapAttachmentRow(row) : null
}

export async function touchSystemEmailThread(input: {
	db: D1Database
	threadId: string
	lastMessageAt?: string | null
}) {
	const updatedAt = nowIso()
	const lastMessageAt = input.lastMessageAt ?? updatedAt
	await input.db.batch([
		input.db
			.prepare(
				`UPDATE system_email_threads
				SET last_message_at = ?, updated_at = ?
				WHERE id = ?`,
			)
			.bind(lastMessageAt, updatedAt, input.threadId),
		input.db
			.prepare(
				`UPDATE email_threads
				SET last_message_at = ?, updated_at = ?
				WHERE id = ? AND user_id = ?`,
			)
			.bind(lastMessageAt, updatedAt, input.threadId, systemEmailOwnerId),
	])
}

export async function updateSystemEmailMessageClassification(input: {
	db: D1Database
	messageId: string
	classification: EmailClassification
	classificationReason?: string | null
	now?: string
}) {
	const updatedAt = input.now ?? nowIso()
	const results = await input.db.batch([
		input.db
			.prepare(
				`UPDATE system_email_messages
				SET classification = ?, classification_reason = ?, updated_at = ?
				WHERE id = ? AND direction = 'inbound'`,
			)
			.bind(
				input.classification,
				input.classificationReason ?? null,
				updatedAt,
				input.messageId,
			),
		input.db
			.prepare(
				`UPDATE email_messages
				SET classification = ?, classification_reason = ?, updated_at = ?
				WHERE id = ? AND user_id = ? AND direction = 'inbound'`,
			)
			.bind(
				input.classification,
				input.classificationReason ?? null,
				updatedAt,
				input.messageId,
				systemEmailOwnerId,
			),
	])
	return Number(results[0]?.meta.changes ?? 0) > 0
}

export async function deleteEmptySystemEmailThreads(input: {
	db: D1Database
	before: string
	limit: number
}) {
	const rows = await input.db
		.prepare(
			`SELECT thread.id
			FROM system_email_threads thread
			WHERE thread.created_at < ?
				AND NOT EXISTS (
					SELECT 1 FROM system_email_messages message
					WHERE message.thread_id = thread.id
				)
			ORDER BY thread.created_at ASC, thread.id ASC
			LIMIT ?`,
		)
		.bind(input.before, input.limit)
		.all<{ id: string }>()
	const ids = (rows.results ?? []).map((row) => row.id)
	if (ids.length === 0) return 0
	const statements = ids.flatMap((id) => [
		input.db
			.prepare(
				`DELETE FROM system_email_threads
				WHERE id = ? AND NOT EXISTS (
					SELECT 1 FROM system_email_messages WHERE thread_id = ?
				)`,
			)
			.bind(id, id),
		input.db
			.prepare(
				`DELETE FROM email_threads
				WHERE id = ? AND user_id = ? AND NOT EXISTS (
					SELECT 1 FROM email_messages WHERE thread_id = ?
				)`,
			)
			.bind(id, systemEmailOwnerId, id),
	])
	const results = await input.db.batch(statements)
	return results.reduce(
		(total, result, index) =>
			index % 2 === 0 ? total + Number(result.meta.changes ?? 0) : total,
		0,
	)
}

export async function deleteSystemEmailMessageById(input: {
	db: D1Database
	blobs: R2Bucket
	messageId: string
}): Promise<DeleteEmailMessageByIdResult> {
	const message = await getSystemEmailMessageById(input)
	if (!message) {
		return {
			messageFound: false,
			ownerUserId: null,
			attachmentsSeen: 0,
			externalAttachmentsSeen: 0,
			blobDeletions: [],
		}
	}
	const attachments = await listSystemEmailAttachments(input)
	const inventory = [
		{
			key: emailRawMimeKey(systemEmailOwnerId, input.messageId),
			role: 'raw_mime' as const,
		},
		...attachments.flatMap((attachment) =>
			attachment.storageKey
				? [{ key: attachment.storageKey, role: 'attachment' as const }]
				: [],
		),
	]
	const blobDeletions: DeleteEmailMessageByIdResult['blobDeletions'] = []
	for (const entry of inventory) {
		try {
			await input.blobs.delete(entry.key)
			blobDeletions.push({ ...entry, deleted: true })
		} catch (error) {
			console.warn('email-blob-delete-failed', entry.key, error)
			blobDeletions.push({ ...entry, deleted: false })
		}
	}
	if (blobDeletions.some((entry) => !entry.deleted)) {
		throw new Error(
			'System email blob deletion failed before authoritative row delete.',
		)
	}
	await input.db.batch([
		input.db
			.prepare(`DELETE FROM system_email_attachments WHERE message_id = ?`)
			.bind(input.messageId),
		input.db
			.prepare(`DELETE FROM system_email_delivery_events WHERE message_id = ?`)
			.bind(input.messageId),
		input.db
			.prepare(`DELETE FROM system_email_messages WHERE id = ?`)
			.bind(input.messageId),
		input.db
			.prepare(
				`DELETE FROM email_attachments
				WHERE message_id = ? AND EXISTS (
					SELECT 1 FROM email_messages
					WHERE email_messages.id = email_attachments.message_id
						AND email_messages.user_id = ?
				)`,
			)
			.bind(input.messageId, systemEmailOwnerId),
		input.db
			.prepare(
				`DELETE FROM email_delivery_events
				WHERE message_id = ? AND user_id = ?`,
			)
			.bind(input.messageId, systemEmailOwnerId),
		input.db
			.prepare(`DELETE FROM email_messages WHERE id = ? AND user_id = ?`)
			.bind(input.messageId, systemEmailOwnerId),
	])
	return {
		messageFound: true,
		ownerUserId: systemEmailOwnerId,
		attachmentsSeen: attachments.length,
		externalAttachmentsSeen: attachments.filter(
			(attachment) => attachment.storageKind === 'external',
		).length,
		blobDeletions,
	}
}

export type SystemEmailAdminListRow = Record<string, unknown>

export async function listSystemEmailAdminMessages(input: {
	db: D1Database
	pageSize: number
	offset: number
}) {
	const [total, rows] = await Promise.all([
		input.db
			.prepare(
				`SELECT COUNT(*) AS total
				FROM system_email_messages
				WHERE direction = 'inbound'`,
			)
			.first<{ total: number }>(),
		input.db
			.prepare(
				`SELECT message.id, address.local_part AS inbox_local_part,
					message.from_address, message.envelope_from, message.subject,
					message.processing_status, message.raw_size, message.received_at,
					message.created_at
				FROM system_email_messages AS message
				LEFT JOIN email_inbox_addresses AS address
					ON address.inbox_id = message.inbox_id
					AND address.user_id = ?
				WHERE message.direction = 'inbound'
				ORDER BY message.created_at DESC, message.id DESC
				LIMIT ? OFFSET ?`,
			)
			.bind(systemEmailOwnerId, input.pageSize, input.offset)
			.all<SystemEmailAdminListRow>(),
	])
	return {
		total: Number(total?.total ?? 0),
		rows: rows.results ?? [],
	}
}

export async function getSystemEmailAdminMessageRow(input: {
	db: D1Database
	messageId: string
}) {
	return await input.db
		.prepare(
			`SELECT message.*, address.local_part AS inbox_local_part
			FROM system_email_messages AS message
			LEFT JOIN email_inbox_addresses AS address
				ON address.inbox_id = message.inbox_id
				AND address.user_id = ?
			WHERE message.id = ?
			LIMIT 1`,
		)
		.bind(systemEmailOwnerId, input.messageId)
		.first<Record<string, unknown>>()
}

export function systemEmailAttachmentRecords(
	rows: ReadonlyArray<Record<string, unknown>>,
): Array<EmailAttachmentRecord> {
	return rows.map(mapAttachmentRow)
}
