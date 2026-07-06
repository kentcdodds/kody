import PostalMime from 'postal-mime'
import {
	type EmailAttachmentRecord,
	type EmailDirection,
	type EmailDeliveryEventType,
	type EmailInboxAddressRecord,
	type EmailInboxRecord,
	type EmailMessageRecord,
	type EmailProcessingStatus,
	type EmailSenderIdentityRecord,
	type EmailThreadRecord,
} from './types.ts'

function nowIso() {
	return new Date().toISOString()
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}
function parseJsonArray(value: string | null) {
	if (!value) return []
	const parsed = JSON.parse(value) as unknown
	return Array.isArray(parsed) ? parsed : []
}

function parseOptionalJsonRecord(value: string | null) {
	if (!value) return null
	const parsed = JSON.parse(value) as unknown
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return null
	}
	return parsed as Record<string, unknown>
}

function mapInboxRow(row: Record<string, unknown>): EmailInboxRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		name: String(row['name']),
		description: row['description'] == null ? '' : String(row['description']),
		enabled: Number(row['enabled']) === 1,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapInboxAddressRow(
	row: Record<string, unknown>,
): EmailInboxAddressRecord {
	return {
		id: String(row['id']),
		inboxId: String(row['inbox_id']),
		userId: String(row['user_id']),
		address: String(row['address']),
		localPart: String(row['local_part']),
		domain: String(row['domain']),
		enabled: Number(row['enabled']) === 1,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapThreadRow(row: Record<string, unknown>): EmailThreadRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		subjectNormalized:
			row['subject_normalized'] == null
				? null
				: String(row['subject_normalized']),
		rootMessageIdHeader:
			row['root_message_id_header'] == null
				? null
				: String(row['root_message_id_header']),
		lastMessageAt: String(row['last_message_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapMessageRow(row: Record<string, unknown>): EmailMessageRecord {
	return {
		id: String(row['id']),
		direction: String(row['direction']) as EmailDirection,
		userId: String(row['user_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		threadId: row['thread_id'] == null ? null : String(row['thread_id']),
		senderIdentityId:
			row['sender_identity_id'] == null
				? null
				: String(row['sender_identity_id']),
		fromAddress:
			row['from_address'] == null ? null : String(row['from_address']),
		envelopeFrom:
			row['envelope_from'] == null ? null : String(row['envelope_from']),
		toAddresses: parseJsonArray(
			String(row['to_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		ccAddresses: parseJsonArray(
			String(row['cc_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		bccAddresses: parseJsonArray(
			String(row['bcc_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		replyToAddresses: parseJsonArray(
			String(row['reply_to_addresses_json'] ?? '[]'),
		).filter((value): value is string => typeof value === 'string'),
		subject: row['subject'] == null ? null : String(row['subject']),
		messageIdHeader:
			row['message_id_header'] == null
				? null
				: String(row['message_id_header']),
		inReplyToHeader:
			row['in_reply_to_header'] == null
				? null
				: String(row['in_reply_to_header']),
		references: parseJsonArray(String(row['references_json'] ?? '[]')).filter(
			(value): value is string => typeof value === 'string',
		),
		headers: parseOptionalJsonRecord(
			row['headers_json'] == null ? null : String(row['headers_json']),
		),
		authResults:
			row['auth_results'] == null ? null : String(row['auth_results']),
		textBody: row['text_body'] == null ? null : String(row['text_body']),
		htmlBody: row['html_body'] == null ? null : String(row['html_body']),
		rawMime: row['raw_mime'] == null ? null : String(row['raw_mime']),
		rawSize: row['raw_size'] == null ? null : Number(row['raw_size']),
		processingStatus: String(row['processing_status']) as EmailProcessingStatus,
		providerMessageId:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		error: row['error'] == null ? null : String(row['error']),
		receivedAt: row['received_at'] == null ? null : String(row['received_at']),
		sentAt: row['sent_at'] == null ? null : String(row['sent_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapAttachmentRow(row: Record<string, unknown>): EmailAttachmentRecord {
	return {
		id: String(row['id']),
		messageId: String(row['message_id']),
		filename: row['filename'] == null ? null : String(row['filename']),
		contentType:
			row['content_type'] == null ? null : String(row['content_type']),
		contentId: row['content_id'] == null ? null : String(row['content_id']),
		disposition: row['disposition'] == null ? null : String(row['disposition']),
		size: Number(row['size'] ?? 0),
		storageKind: String(row['storage_kind']),
		storageKey: row['storage_key'] == null ? null : String(row['storage_key']),
		createdAt: String(row['created_at']),
	}
}

export async function createEmailInbox(input: {
	db: D1Database
	userId: string
	name: string
	description?: string | null
	packageId?: string | null
}) {
	const timestamp = nowIso()
	const row = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		package_id: input.packageId ?? null,
		name: input.name,
		description: input.description ?? null,
		enabled: 1,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, package_id, name, description, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.package_id,
			row.name,
			row.description,
			row.enabled,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapInboxRow(row)
}

export async function deleteEmailInboxAddressById(input: {
	db: D1Database
	addressId: string
}) {
	await input.db
		.prepare(`DELETE FROM email_inbox_addresses WHERE id = ?`)
		.bind(input.addressId)
		.run()
}

export async function createEmailInboxAddress(input: {
	db: D1Database
	inboxId: string
	userId: string
	address: string
	localPart: string
	domain: string
}) {
	const timestamp = nowIso()
	const row = {
		id: crypto.randomUUID(),
		inbox_id: input.inboxId,
		user_id: input.userId,
		address: input.address,
		local_part: input.localPart,
		domain: input.domain,
		enabled: 1,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_inbox_addresses (
				id, inbox_id, user_id, address, local_part, domain, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.inbox_id,
			row.user_id,
			row.address,
			row.local_part,
			row.domain,
			row.enabled,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapInboxAddressRow(row)
}

export async function listEmailInboxesForUser(input: {
	db: D1Database
	userId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_inboxes
			WHERE user_id = ?
			ORDER BY created_at DESC, id DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapInboxRow)
}

export async function listEmailInboxAddressesForUser(input: {
	db: D1Database
	userId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_inbox_addresses
			WHERE user_id = ?
			ORDER BY created_at DESC, id DESC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapInboxAddressRow)
}

/**
 * Read the row holding a (globally unique) address regardless of its
 * enabled state, so callers can distinguish "address free" from "address
 * held but disabled" instead of tripping the unique constraint.
 */
export async function getEmailInboxAddressByAddress(input: {
	db: D1Database
	address: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inbox_addresses
			WHERE address = ?
			LIMIT 1`,
		)
		.bind(input.address)
		.first<Record<string, unknown>>()
	return row ? mapInboxAddressRow(row) : null
}

export async function getEmailInboxById(input: {
	db: D1Database
	userId?: string
	id: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inboxes
			WHERE id = ?
				AND (? IS NULL OR user_id = ?)
			LIMIT 1`,
		)
		.bind(input.id, input.userId ?? null, input.userId ?? null)
		.first<Record<string, unknown>>()
	return row ? mapInboxRow(row) : null
}

export async function getEmailInboxByName(input: {
	db: D1Database
	userId: string
	name: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inboxes
			WHERE user_id = ?
				AND name = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<Record<string, unknown>>()
	return row ? mapInboxRow(row) : null
}

function mapSenderIdentityRow(
	row: Record<string, unknown>,
): EmailSenderIdentityRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		email: String(row['email']),
		domain: String(row['domain']),
		status: String(row['status']) as EmailSenderIdentityRecord['status'],
		verifiedAt: row['verified_at'] == null ? null : String(row['verified_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

async function getSenderIdentityByEmail(input: {
	db: D1Database
	userId: string
	email: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_identities
			WHERE user_id = ?
				AND email = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.email)
		.first<Record<string, unknown>>()
	return row ? mapSenderIdentityRow(row) : null
}

/**
 * Ensure the platform-assigned sender identity row
 * (`{username}@<platform domain>`, status `verified`) exists for the user.
 * This is the only way sender identities are created: they are provisioned
 * by the platform, never self-registered or "verified" by users. Any
 * non-verified stored status is overwritten: identity status carries no
 * authorization meaning under the platform-assigned model (outbound is
 * gated by the verified-account check and the reserved-username block, not
 * by identity rows), so a legacy 'pending'/'disabled' row is just stale
 * bookkeeping to repair.
 */
export async function ensurePlatformSenderIdentity(input: {
	db: D1Database
	userId: string
	email: string
	domain: string
}): Promise<EmailSenderIdentityRecord> {
	const existing = await getSenderIdentityByEmail(input)
	if (existing?.status === 'verified') return existing
	const timestamp = nowIso()
	await input.db
		.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, email, domain, status, verified_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)
			ON CONFLICT(user_id, email) DO UPDATE SET
				domain = excluded.domain,
				status = excluded.status,
				verified_at = excluded.verified_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			crypto.randomUUID(),
			input.userId,
			input.email,
			input.domain,
			timestamp,
			timestamp,
			timestamp,
		)
		.run()
	const persisted = await getSenderIdentityByEmail(input)
	if (!persisted) {
		throw new Error('Failed to provision the platform sender identity.')
	}
	return persisted
}

async function findThreadForMessage(input: {
	db: D1Database
	userId: string
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
				`SELECT thread.*
				FROM email_threads thread
				JOIN email_messages message ON message.thread_id = thread.id
				WHERE thread.user_id = ?
					AND (? IS NULL OR thread.inbox_id = ?)
					AND message.message_id_header = ?
				LIMIT 1`,
			)
			.bind(input.userId, input.inboxId ?? null, input.inboxId ?? null, id)
			.first<Record<string, unknown>>()
		if (row) return mapThreadRow(row)
	}
	return null
}

export const findEmailThreadForInboundMessage = findThreadForMessage

export async function createEmailThread(input: {
	db: D1Database
	userId: string
	inboxId?: string | null
	subjectNormalized?: string | null
	rootMessageIdHeader?: string | null
	lastMessageAt?: string | null
}) {
	const timestamp = nowIso()
	const row = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		inbox_id: input.inboxId ?? null,
		subject_normalized: input.subjectNormalized ?? '',
		root_message_id_header: input.rootMessageIdHeader ?? null,
		last_message_at: input.lastMessageAt ?? timestamp,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_threads (
				id, user_id, inbox_id, subject_normalized, root_message_id_header, last_message_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.inbox_id,
			row.subject_normalized,
			row.root_message_id_header,
			row.last_message_at,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapThreadRow(row)
}

export async function touchEmailThread(input: {
	db: D1Database
	threadId: string
	lastMessageAt?: string | null
}) {
	await input.db
		.prepare(
			`UPDATE email_threads
			SET last_message_at = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(input.lastMessageAt ?? nowIso(), nowIso(), input.threadId)
		.run()
}

export async function insertEmailMessage(input: {
	db: D1Database
	message: {
		id?: string
		direction: EmailDirection
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
		rawMime?: string | null
		rawSize?: number | null
		processingStatus: EmailProcessingStatus
		providerMessageId?: string | null
		error?: string | null
		receivedAt?: string | null
		sentAt?: string | null
	}
}) {
	const timestamp = nowIso()
	const row = {
		id: input.message.id ?? crypto.randomUUID(),
		direction: input.message.direction,
		user_id: input.message.userId,
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
		text_body: input.message.textBody ?? null,
		html_body: input.message.htmlBody ?? null,
		raw_mime: input.message.rawMime ?? null,
		raw_size: input.message.rawSize ?? 0,
		processing_status: input.message.processingStatus,
		provider_message_id: input.message.providerMessageId ?? null,
		error: input.message.error ?? null,
		received_at: input.message.receivedAt ?? null,
		sent_at: input.message.sentAt ?? null,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, inbox_id, thread_id, sender_identity_id,
				from_address, envelope_from, to_addresses_json, cc_addresses_json,
				bcc_addresses_json, reply_to_addresses_json, subject, message_id_header,
				in_reply_to_header, references_json, headers_json, auth_results,
				text_body, html_body, raw_mime, raw_size, processing_status,
				provider_message_id, error, received_at, sent_at,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.direction,
			row.user_id,
			row.inbox_id,
			row.thread_id,
			row.sender_identity_id,
			row.from_address,
			row.envelope_from,
			row.to_addresses_json,
			row.cc_addresses_json,
			row.bcc_addresses_json,
			row.reply_to_addresses_json,
			row.subject,
			row.message_id_header,
			row.in_reply_to_header,
			row.references_json,
			row.headers_json,
			row.auth_results,
			row.text_body,
			row.html_body,
			row.raw_mime,
			row.raw_size,
			row.processing_status,
			row.provider_message_id,
			row.error,
			row.received_at,
			row.sent_at,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapMessageRow(row)
}

export async function updateEmailMessageDelivery(input: {
	db: D1Database
	messageId: string
	status: EmailProcessingStatus
	providerMessageId?: string | null
	error?: string | null
	sentAt?: string | null
}) {
	await input.db
		.prepare(
			`UPDATE email_messages
			SET processing_status = ?,
				provider_message_id = ?,
				error = ?,
				sent_at = ?,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			input.status,
			input.providerMessageId ?? null,
			input.error ?? null,
			input.sentAt ?? null,
			nowIso(),
			input.messageId,
		)
		.run()
}

export async function getEmailMessageById(input: {
	db: D1Database
	userId: string
	messageId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_messages
			WHERE id = ?
				AND user_id = ?
			LIMIT 1`,
		)
		.bind(input.messageId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapMessageRow(row) : null
}

export async function getEmailMessageWithAttachmentsById(input: {
	db: D1Database
	userId: string
	messageId: string
}) {
	const message = await getEmailMessageById(input)
	if (!message) return null
	const attachments = await listEmailAttachmentsForMessage({
		db: input.db,
		messageId: message.id,
	})
	return {
		message,
		attachments,
	}
}

export async function getEmailMessageByMessageIdHeader(input: {
	db: D1Database
	userId: string
	messageIdHeader: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_messages
			WHERE user_id = ?
				AND message_id_header = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.messageIdHeader)
		.first<Record<string, unknown>>()
	return row ? mapMessageRow(row) : null
}

export async function listEmailMessages(input: {
	db: D1Database
	userId: string
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	limit: number
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_messages
			WHERE user_id = ?
				AND (? IS NULL OR inbox_id = ?)
				AND (? IS NULL OR direction = ?)
				AND (? IS NULL OR processing_status = ?)
			ORDER BY created_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(
			input.userId,
			input.inboxId ?? null,
			input.inboxId ?? null,
			input.direction ?? null,
			input.direction ?? null,
			input.processingStatus ?? null,
			input.processingStatus ?? null,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapMessageRow)
}

/** Escape LIKE wildcards so user queries match literally. */
function escapeLikePattern(value: string) {
	return value.replaceAll(/[\\%_]/g, (character) => `\\${character}`)
}

/**
 * Case-insensitive substring search over stored messages' subject, header
 * From, and envelope sender. Same filters, ordering, and limit contract as
 * `listEmailMessages`; always scoped to one user.
 *
 * The leading-wildcard LIKE is a per-user linear scan (bounded by the
 * stored_email_messages entitlement cap). Revisit with FTS5 or a search
 * index if mailboxes outgrow that.
 */
export async function searchEmailMessages(input: {
	db: D1Database
	userId: string
	query: string
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	limit: number
}) {
	const pattern = `%${escapeLikePattern(input.query.trim().toLowerCase())}%`
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_messages
			WHERE user_id = ?
				AND (? IS NULL OR inbox_id = ?)
				AND (? IS NULL OR direction = ?)
				AND (? IS NULL OR processing_status = ?)
				AND (
					LOWER(subject) LIKE ? ESCAPE '\\'
					OR LOWER(from_address) LIKE ? ESCAPE '\\'
					OR LOWER(COALESCE(envelope_from, '')) LIKE ? ESCAPE '\\'
				)
			ORDER BY created_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(
			input.userId,
			input.inboxId ?? null,
			input.inboxId ?? null,
			input.direction ?? null,
			input.direction ?? null,
			input.processingStatus ?? null,
			input.processingStatus ?? null,
			pattern,
			pattern,
			pattern,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapMessageRow)
}

export async function deleteEmailMessageById(input: {
	db: D1Database
	messageId: string
}) {
	await input.db
		.prepare(`DELETE FROM email_messages WHERE id = ?`)
		.bind(input.messageId)
		.run()
}

export async function insertEmailAttachments(input: {
	db: D1Database
	messageId: string
	attachments: Array<{
		filename?: string | null
		contentType?: string | null
		contentId?: string | null
		disposition?: string | null
		size?: number | null
		storageKind: string
		storageKey?: string | null
	}>
}) {
	const timestamp = nowIso()
	for (const attachment of input.attachments) {
		await input.db
			.prepare(
				`INSERT INTO email_attachments (
					id, message_id, filename, content_type, content_id, disposition,
					size, storage_kind, storage_key, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				input.messageId,
				attachment.filename ?? null,
				attachment.contentType ?? null,
				attachment.contentId ?? null,
				attachment.disposition ?? null,
				attachment.size ?? null,
				attachment.storageKind,
				attachment.storageKey ?? null,
				timestamp,
			)
			.run()
	}
}
export async function insertEmailMessageWithAttachments(
	input: Parameters<typeof insertEmailMessage>[0] & {
		attachments: Parameters<typeof insertEmailAttachments>[0]['attachments']
	},
) {
	const message = await insertEmailMessage(input)
	try {
		await insertEmailAttachments({
			db: input.db,
			messageId: message.id,
			attachments: input.attachments,
		})
		return message
	} catch (error) {
		await deleteEmailMessageById({
			db: input.db,
			messageId: message.id,
		}).catch(() => undefined)
		throw error
	}
}

export async function listEmailAttachmentsForMessage(input: {
	db: D1Database
	messageId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_attachments
			WHERE message_id = ?
			ORDER BY created_at ASC, id ASC`,
		)
		.bind(input.messageId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapAttachmentRow)
}

export async function getEmailAttachmentById(input: {
	db: D1Database
	userId: string
	attachmentId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT attachment.*
			FROM email_attachments attachment
			JOIN email_messages message ON message.id = attachment.message_id
			WHERE attachment.id = ?
				AND message.user_id = ?
			LIMIT 1`,
		)
		.bind(input.attachmentId, input.userId)
		.first<Record<string, unknown>>()
	if (!row) return null
	const attachment = mapAttachmentRow(row)
	const message = await getEmailMessageById({
		db: input.db,
		userId: input.userId,
		messageId: attachment.messageId,
	})
	if (!message?.rawMime) {
		return {
			...attachment,
			content: null,
			contentBase64: null,
		}
	}
	const parsed = await PostalMime.parse(message.rawMime, {
		attachmentEncoding: 'arraybuffer',
	})
	const matched = parsed.attachments.find((candidate) => {
		if ((candidate.filename ?? null) !== attachment.filename) return false
		if (candidate.mimeType !== (attachment.contentType ?? candidate.mimeType)) {
			return false
		}
		if ((candidate.contentId ?? null) !== attachment.contentId) return false
		if ((candidate.disposition ?? null) !== attachment.disposition) return false
		const content = candidate.content
		const size =
			typeof content === 'string'
				? new TextEncoder().encode(content).byteLength
				: content.byteLength
		return size === attachment.size
	})
	if (!matched) {
		return {
			...attachment,
			content: null,
			contentBase64: null,
		}
	}
	const bytes =
		typeof matched.content === 'string'
			? new TextEncoder().encode(matched.content)
			: new Uint8Array(matched.content)
	return {
		...attachment,
		content: matched.content,
		contentBase64: bytesToBase64(bytes),
	}
}

/**
 * How many quota/size/verification rejections per inbox per UTC day get
 * their own delivery-event row before collapsing into the daily aggregate
 * row.
 */
export const maxDetailedEmailRejectionEventsPerDay = 5

/**
 * Record an entitlement/size/verification rejection without unbounded row
 * growth. Every rejection upserts one aggregate 'rejected' event per inbox
 * per UTC day (deterministic id, counter in detail_json), and only the
 * first `maxDetailedEmailRejectionEventsPerDay` attempts of the day also
 * store an individual detailed event. This traffic is attacker-controlled
 * and not limited by the daily receive counter (over-quota mail has
 * already exhausted it; unverified-account mail never consumes it), so
 * without this cap a flood of rejected mail would grow D1 one row per
 * attempt — the denial-of-wallet shape the quotas exist to prevent.
 */
export async function recordBoundedEmailRejectionEvent(input: {
	db: D1Database
	userId: string
	inboxId: string
	recipient: string
	reason: string
	phase: 'entitlement' | 'size' | 'account-verification'
	now?: Date
}) {
	const now = input.now ?? new Date()
	const nowIsoString = now.toISOString()
	const day = nowIsoString.slice(0, 'YYYY-MM-DD'.length)
	const aggregateDetail = JSON.stringify({
		aggregate: true,
		day,
		count: 1,
		last_reason: input.reason,
		last_phase: input.phase,
		last_at: nowIsoString,
	})
	const row = await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, user_id, inbox_id, event_type, provider, detail_json, created_at
			) VALUES (?, ?, ?, 'rejected', 'cloudflare-email-routing', ?, ?)
			ON CONFLICT(id) DO UPDATE SET detail_json = json_set(
				email_delivery_events.detail_json,
				'$.count', COALESCE(json_extract(email_delivery_events.detail_json, '$.count'), 0) + 1,
				'$.last_reason', json_extract(excluded.detail_json, '$.last_reason'),
				'$.last_phase', json_extract(excluded.detail_json, '$.last_phase'),
				'$.last_at', json_extract(excluded.detail_json, '$.last_at')
			)
			RETURNING json_extract(detail_json, '$.count') AS count`,
		)
		.bind(
			`email-rejections:${input.inboxId}:${day}`,
			input.userId,
			input.inboxId,
			aggregateDetail,
			nowIsoString,
		)
		.first<{ count: number }>()
	const rejectionsToday = Number(row?.count ?? 1)
	if (rejectionsToday <= maxDetailedEmailRejectionEventsPerDay) {
		await insertEmailDeliveryEvent({
			db: input.db,
			userId: input.userId,
			inboxId: input.inboxId,
			eventType: 'rejected',
			provider: 'cloudflare-email-routing',
			detail: {
				recipient: input.recipient,
				reason: input.reason,
				phase: input.phase,
			},
		})
	}
	return rejectionsToday
}

export async function insertEmailDeliveryEvent(input: {
	db: D1Database
	messageId?: string | null
	userId?: string | null
	inboxId?: string | null
	eventType: EmailDeliveryEventType
	provider?: string | null
	providerMessageId?: string | null
	detail?: Record<string, unknown> | null
}) {
	await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider,
				provider_message_id, detail_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.messageId ?? null,
			input.userId ?? null,
			input.inboxId ?? null,
			input.eventType,
			input.provider ?? null,
			input.providerMessageId ?? null,
			JSON.stringify(input.detail ?? {}),
			nowIso(),
		)
		.run()
}
