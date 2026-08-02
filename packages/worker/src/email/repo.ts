import {
	maxRestorableTextColumnBytes,
	truncateToUtf8Bytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { parseJsonArray } from '@kody-internal/shared/json-parsing.ts'
import {
	getOutboundProviderIndexRow,
	prepareOutboundProviderIndexSyncStatements,
} from './outbound-provider-index.ts'
import {
	emailClassificationValues,
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailDeliveryEventRecord,
	type EmailDirection,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
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

export const emailBodyTruncationNotice =
	'\n[truncated for backup-safe storage; the full message is retained in the raw MIME object]'

/**
 * Bound stored email body columns so a full `email_messages` row stays
 * below D1's import statement limit (oversized rows make D1 backups
 * un-importable). The canonical full message remains in the R2 raw MIME
 * object referenced by `raw_mime_key`.
 */
function boundedEmailBody(body: string | null | undefined): string | null {
	if (body == null) return null
	if (utf8ByteLength(body) <= maxRestorableTextColumnBytes) return body
	return (
		truncateToUtf8Bytes(
			body,
			maxRestorableTextColumnBytes - utf8ByteLength(emailBodyTruncationNotice),
		) + emailBodyTruncationNotice
	)
}

export type EmailInboundDeliveryFence = {
	deliveryId: string
	userId: string
	storageLease: string
}

import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'

export { emailAttachmentBlobKey, emailRawMimeKey }

// One corrupt stored row must not fail an entire list/search response, so
// the record parser degrades to an empty shape on malformed JSON.
function parseOptionalJsonRecord(value: string | null) {
	if (!value) return null
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		return parsed as Record<string, unknown>
	} catch {
		return null
	}
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

function mapClassification(value: unknown): EmailClassification {
	if (value == null) return 'accepted'
	const classification = String(value)
	return (emailClassificationValues as ReadonlyArray<string>).includes(
		classification,
	)
		? (classification as EmailClassification)
		: 'accepted'
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
		rawMimeKey:
			row['raw_mime_key'] == null ? null : String(row['raw_mime_key']),
		rawSize: row['raw_size'] == null ? null : Number(row['raw_size']),
		processingStatus: String(row['processing_status']) as EmailProcessingStatus,
		classification: mapClassification(row['classification']),
		classificationReason:
			row['classification_reason'] == null
				? null
				: String(row['classification_reason']),
		providerMessageId:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		deliveryStatus:
			row['delivery_status'] == null
				? null
				: (String(row['delivery_status']) as EmailDeliveryStatus),
		deliveryStatusAt:
			row['delivery_status_at'] == null
				? null
				: String(row['delivery_status_at']),
		error: row['error'] == null ? null : String(row['error']),
		receivedAt: row['received_at'] == null ? null : String(row['received_at']),
		sentAt: row['sent_at'] == null ? null : String(row['sent_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapDeliveryEventRow(
	row: Record<string, unknown>,
): EmailDeliveryEventRecord {
	return {
		id: String(row['id']),
		messageId: row['message_id'] == null ? null : String(row['message_id']),
		userId: row['user_id'] == null ? null : String(row['user_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		eventType: String(row['event_type']) as EmailDeliveryEventType,
		provider: row['provider'] == null ? null : String(row['provider']),
		providerMessageId:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		providerEventId:
			row['provider_event_id'] == null
				? null
				: String(row['provider_event_id']),
		detailJson: String(row['detail_json'] ?? '{}'),
		createdAt: String(row['created_at']),
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
 * Platform provisioning is the only writer; identities are always verified.
 * Race-tolerant with signup / first-inbound concurrency via ON CONFLICT.
 */
export async function ensurePlatformSenderIdentity(input: {
	db: D1Database
	userId: string
	email: string
	domain: string
}): Promise<EmailSenderIdentityRecord> {
	const existing = await getSenderIdentityByEmail(input)
	if (existing) return existing
	const timestamp = nowIso()
	await input.db
		.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, email, domain, status, verified_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)
			ON CONFLICT(user_id, email) DO UPDATE SET
				domain = excluded.domain,
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

/**
 * Owner-scoped thread lookup for D1 → Mailbox graph mirrors and other
 * strictly user-bound readers. Returns null when absent or owned by another
 * user — never use for inbound delivery fencing.
 */
export async function getEmailThreadById(input: {
	db: D1Database
	userId: string
	threadId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_threads
			WHERE id = ?
				AND user_id = ?
			LIMIT 1`,
		)
		.bind(input.threadId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapThreadRow(row) : null
}

export async function createEmailThread(input: {
	db: D1Database
	id?: string
	userId: string
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
		user_id: input.userId,
		inbox_id: input.inboxId ?? null,
		subject_normalized: input.subjectNormalized ?? '',
		root_message_id_header: input.rootMessageIdHeader ?? null,
		last_message_at: input.lastMessageAt ?? timestamp,
		created_at: timestamp,
		updated_at: timestamp,
	}
	const values = [
		row.id,
		row.user_id,
		row.inbox_id,
		row.subject_normalized,
		row.root_message_id_header,
		row.last_message_at,
		row.created_at,
		row.updated_at,
	]
	const fence = input.inboundDeliveryFence
	await input.db
		.prepare(
			`${input.ignoreConflict ? 'INSERT OR IGNORE' : 'INSERT'} INTO email_threads (
				id, user_id, inbox_id, subject_normalized, root_message_id_header, last_message_at, created_at, updated_at
			) ${
				fence
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?
						WHERE EXISTS (
							SELECT 1 FROM email_delivery_events
							WHERE id = ?
								AND user_id = ?
								AND json_extract(detail_json, '$.state') = 'storing'
								AND json_extract(detail_json, '$.storageLease') = ?
						)`
					: 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			}`,
		)
		.bind(
			...values,
			...(fence ? [fence.deliveryId, fence.userId, fence.storageLease] : []),
		)
		.run()
	return mapThreadRow(row)
}

export async function deleteEmptyEmailThreads(input: {
	db: D1Database
	userId: string
	before: string
	limit: number
}) {
	const rows = await input.db
		.prepare(
			`SELECT thread.id
			FROM email_threads thread
			WHERE thread.user_id = ?
				AND thread.created_at < ?
				AND NOT EXISTS (
					SELECT 1 FROM email_messages message
					WHERE message.thread_id = thread.id
				)
			ORDER BY thread.created_at ASC, thread.id ASC
			LIMIT ?`,
		)
		.bind(input.userId, input.before, input.limit)
		.all<{ id: string }>()
	const ids = (rows.results ?? []).map((row) => row.id)
	if (ids.length === 0) return 0
	const results = await input.db.batch(
		ids.map((id) =>
			input.db
				.prepare(
					`DELETE FROM email_threads
					WHERE id = ?
						AND user_id = ?
						AND NOT EXISTS (
							SELECT 1 FROM email_messages
							WHERE thread_id = ?
						)`,
				)
				.bind(id, input.userId, id),
		),
	)
	return results.reduce(
		(total, result) => total + Number(result.meta.changes ?? 0),
		0,
	)
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
	inboundDeliveryFence?: EmailInboundDeliveryFence
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
}) {
	const timestamp = nowIso()
	const messageId = input.message.id ?? crypto.randomUUID()
	const row = {
		id: messageId,
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
		text_body: boundedEmailBody(input.message.textBody),
		html_body: boundedEmailBody(input.message.htmlBody),
		raw_mime_key: input.message.rawMimeKey ?? null,
		raw_size: input.message.rawSize ?? 0,
		processing_status: input.message.processingStatus,
		classification: input.message.classification ?? 'accepted',
		classification_reason: input.message.classificationReason ?? null,
		provider_message_id: input.message.providerMessageId ?? null,
		error: input.message.error ?? null,
		received_at: input.message.receivedAt ?? null,
		sent_at: input.message.sentAt ?? null,
		created_at: timestamp,
		updated_at: timestamp,
	}
	const fence = input.inboundDeliveryFence
	const insertStatement = input.db
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, inbox_id, thread_id, sender_identity_id,
				from_address, envelope_from, to_addresses_json, cc_addresses_json,
				bcc_addresses_json, reply_to_addresses_json, subject, message_id_header,
				in_reply_to_header, references_json, headers_json, auth_results,
				text_body, html_body, raw_mime_key, raw_size, processing_status,
				classification, classification_reason,
				provider_message_id, error, received_at, sent_at,
				created_at, updated_at
			) ${
				fence
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
						WHERE EXISTS (
							SELECT 1 FROM email_delivery_events
							WHERE id = ?
								AND user_id = ?
								AND json_extract(detail_json, '$.state') = 'storing'
								AND json_extract(detail_json, '$.storageLease') = ?
						)`
					: 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			}`,
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
			row.raw_mime_key,
			row.raw_size,
			row.processing_status,
			row.classification,
			row.classification_reason,
			row.provider_message_id,
			row.error,
			row.received_at,
			row.sent_at,
			row.created_at,
			row.updated_at,
			...(fence ? [fence.deliveryId, fence.userId, fence.storageLease] : []),
		)
	const shouldIndexProvider =
		row.direction === 'outbound' &&
		row.provider_message_id != null &&
		row.provider_message_id !== ''
	const insertResult = shouldIndexProvider
		? (
				await input.db.batch([
					insertStatement,
					...prepareOutboundProviderIndexSyncStatements({
						db: input.db,
						messageId: row.id,
						providerMessageId: row.provider_message_id,
						now: row.updated_at,
					}),
				])
			)[0]
		: await insertStatement.run()
	if (fence && Number(insertResult?.meta.changes ?? 0) === 0) {
		throw new Error(
			'Inbound delivery storage lease was lost before message insert.',
		)
	}
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
	const updatedAt = nowIso()
	const providerMessageId = input.providerMessageId ?? null
	await input.db.batch([
		input.db
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
				providerMessageId,
				input.error ?? null,
				input.sentAt ?? null,
				updatedAt,
				input.messageId,
			),
		...prepareOutboundProviderIndexSyncStatements({
			db: input.db,
			messageId: input.messageId,
			providerMessageId,
			now: updatedAt,
		}),
	])
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

/** Explicit D1 compatibility count, including the `system:email` owner. */
export async function countEmailMessagesForUser(input: {
	db: D1Database
	userId: string
}) {
	const row = await input.db
		.prepare(`SELECT COUNT(*) AS count FROM email_messages WHERE user_id = ?`)
		.bind(input.userId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * D1-only inbound classification update. Prefer
 * `setEmailMessageClassification` in `service.ts`, which dual-writes the
 * Mailbox graph mirror after a successful mutation. Reclassifying to
 * `accepted` does not retroactively dispatch package subscription events; the
 * receive-time classification decides dispatch exactly once.
 */
export async function updateEmailMessageClassificationInD1(input: {
	db: D1Database
	userId: string
	messageId: string
	classification: EmailClassification
	classificationReason?: string | null
	now?: string
}) {
	const result = await input.db
		.prepare(
			`UPDATE email_messages
			SET classification = ?, classification_reason = ?, updated_at = ?
			WHERE id = ?
				AND user_id = ?
				AND direction = 'inbound'`,
		)
		.bind(
			input.classification,
			input.classificationReason ?? null,
			input.now ?? new Date().toISOString(),
			input.messageId,
			input.userId,
		)
		.run()
	return Number(result.meta.changes ?? 0) > 0
}

/**
 * Resolve an outbound message from the derived provider reverse index, then
 * load the owner-scoped authoritative `email_messages` row. Does not scan the
 * full messages table by provider_message_id.
 */
export async function getOutboundEmailMessageByProviderMessageId(input: {
	db: D1Database
	providerMessageId: string
}) {
	const indexRow = await getOutboundProviderIndexRow({
		db: input.db,
		providerMessageId: input.providerMessageId,
	})
	if (!indexRow) return null
	const message = await getEmailMessageById({
		db: input.db,
		userId: indexRow.userId,
		messageId: indexRow.messageId,
	})
	if (!message || message.direction !== 'outbound') return null
	if (message.providerMessageId !== input.providerMessageId) return null
	return message
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
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
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
				AND (? IS NULL OR delivery_status = ?)
				AND (? IS NULL OR classification = ?)
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
			input.deliveryStatus ?? null,
			input.deliveryStatus ?? null,
			input.classification ?? null,
			input.classification ?? null,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapMessageRow)
}

/**
 * Account-inbox page query: total + OFFSET page with optional substring search
 * and classification filter. Used by the cutover D1 off-path.
 */
export async function listEmailMessagesPageForUser(input: {
	db: D1Database
	userId: string
	query: string
	classification: EmailClassification | null
	pageSize: number
	offset: number
}): Promise<{ total: number; messages: Array<EmailMessageRecord> }> {
	const classification = input.classification
	if (input.query) {
		const pattern = `%${escapeLikePattern(input.query.toLowerCase())}%`
		const [totalResult, messageRows] = await Promise.all([
			input.db
				.prepare(
					`SELECT COUNT(*) AS total
					FROM email_messages
					WHERE user_id = ?
						AND (? IS NULL OR classification = ?)
						AND (
							LOWER(subject) LIKE ? ESCAPE '\\'
							OR LOWER(from_address) LIKE ? ESCAPE '\\'
							OR LOWER(COALESCE(envelope_from, '')) LIKE ? ESCAPE '\\'
						)`,
				)
				.bind(
					input.userId,
					classification,
					classification,
					pattern,
					pattern,
					pattern,
				)
				.first<{ total: number }>(),
			input.db
				.prepare(
					`SELECT *
					FROM email_messages
					WHERE user_id = ?
						AND (? IS NULL OR classification = ?)
						AND (
							LOWER(subject) LIKE ? ESCAPE '\\'
							OR LOWER(from_address) LIKE ? ESCAPE '\\'
							OR LOWER(COALESCE(envelope_from, '')) LIKE ? ESCAPE '\\'
						)
					ORDER BY created_at DESC, id DESC
					LIMIT ? OFFSET ?`,
				)
				.bind(
					input.userId,
					classification,
					classification,
					pattern,
					pattern,
					pattern,
					input.pageSize,
					input.offset,
				)
				.all<Record<string, unknown>>(),
		])
		return {
			total: Number(totalResult?.total ?? 0),
			messages: (messageRows.results ?? []).map(mapMessageRow),
		}
	}

	const [totalResult, messageRows] = await Promise.all([
		input.db
			.prepare(
				`SELECT COUNT(*) AS total
				FROM email_messages
				WHERE user_id = ?
					AND (? IS NULL OR classification = ?)`,
			)
			.bind(input.userId, classification, classification)
			.first<{ total: number }>(),
		input.db
			.prepare(
				`SELECT *
				FROM email_messages
				WHERE user_id = ?
					AND (? IS NULL OR classification = ?)
				ORDER BY created_at DESC, id DESC
				LIMIT ? OFFSET ?`,
			)
			.bind(
				input.userId,
				classification,
				classification,
				input.pageSize,
				input.offset,
			)
			.all<Record<string, unknown>>(),
	])
	return {
		total: Number(totalResult?.total ?? 0),
		messages: (messageRows.results ?? []).map(mapMessageRow),
	}
}

export async function listEmailDeliveryEvents(input: {
	db: D1Database
	userId: string
	messageId?: string | null
	eventType?: EmailDeliveryEventType | null
	limit: number
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_delivery_events
			WHERE user_id = ?
				AND (? IS NULL OR message_id = ?)
				AND (? IS NULL OR event_type = ?)
			ORDER BY created_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(
			input.userId,
			input.messageId ?? null,
			input.messageId ?? null,
			input.eventType ?? null,
			input.eventType ?? null,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapDeliveryEventRow)
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
	deliveryStatus?: EmailDeliveryStatus | null
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
				AND (? IS NULL OR delivery_status = ?)
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
			input.deliveryStatus ?? null,
			input.deliveryStatus ?? null,
			pattern,
			pattern,
			pattern,
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapMessageRow)
}

export type DeleteEmailMessageBlobDeletion = {
	key: string
	role: 'raw_mime' | 'attachment'
	/** True when `blobs.delete` settled without throwing. */
	deleted: boolean
}

export type DeleteEmailMessageByIdResult = {
	messageFound: boolean
	ownerUserId: string | null
	attachmentsSeen: number
	externalAttachmentsSeen: number
	/**
	 * Exact blob keys/outcomes from the R2 delete loop. Keys are for internal
	 * post-delete verification only and must not be returned to clients.
	 */
	blobDeletions: Array<DeleteEmailMessageBlobDeletion>
}

export async function deleteEmailMessageById(input: {
	db: D1Database
	/**
	 * EMAIL_BLOBS bucket; the raw-MIME blob and any external attachment
	 * blobs are deleted with the rows.
	 */
	blobs: R2Bucket
	messageId: string
	/**
	 * Optional owner fence. When set, refuse to mutate unless the captured
	 * `email_messages.user_id` matches (missing/foreign → throw).
	 */
	expectedUserId?: string
	/**
	 * Optional authoritative owner-safe inventory supplied by a Mailbox reader.
	 * D1 rows are still deleted, but only these keys are sent to R2.
	 */
	blobDeletionInventory?: ReadonlyArray<{
		key: string
		role: 'raw_mime' | 'attachment'
	}>
}): Promise<DeleteEmailMessageByIdResult> {
	// Capture ownership and blob keys before D1 delete. A failed read must
	// abort the delete (and be retried) rather than orphan the R2 blobs; only
	// the R2 deletes themselves are best-effort.
	const row = await input.db
		.prepare(`SELECT user_id FROM email_messages WHERE id = ?`)
		.bind(input.messageId)
		.first<{ user_id: string }>()
	if (
		input.expectedUserId !== undefined &&
		(row == null || row.user_id !== input.expectedUserId)
	) {
		throw new Error(
			`Email message not found for expected_user_id=${input.expectedUserId} message_id=${input.messageId}`,
		)
	}
	const attachmentRows = await input.db
		.prepare(
			`SELECT storage_kind, storage_key FROM email_attachments
			WHERE message_id = ?`,
		)
		.bind(input.messageId)
		.all<{ storage_kind: string; storage_key: string | null }>()
	const attachments = attachmentRows.results ?? []
	const d1CapturedBlobs: Array<{
		key: string
		role: 'raw_mime' | 'attachment'
	}> = [
		...(row
			? [
					{
						key: emailRawMimeKey(row.user_id, input.messageId),
						role: 'raw_mime' as const,
					},
				]
			: []),
		...attachments.flatMap((attachment) =>
			attachment.storage_key == null
				? []
				: [
						{
							key: attachment.storage_key,
							role: 'attachment' as const,
						},
					],
		),
	]
	const capturedBlobs = input.blobDeletionInventory
		? [...input.blobDeletionInventory]
		: d1CapturedBlobs
	// Atomic batch: a partial delete (attachments gone, message left) would
	// lose the storage_key values needed to delete the R2 blobs on retry.
	// Provider-index rows cascade via FK ON DELETE CASCADE from email_messages.
	await input.db.batch([
		input.db
			.prepare(`DELETE FROM email_attachments WHERE message_id = ?`)
			.bind(input.messageId),
		input.db
			.prepare(`DELETE FROM email_messages WHERE id = ?`)
			.bind(input.messageId),
	])
	const blobDeletions: Array<DeleteEmailMessageBlobDeletion> = []
	for (const captured of capturedBlobs) {
		try {
			await input.blobs.delete(captured.key)
			blobDeletions.push({ ...captured, deleted: true })
		} catch (error: unknown) {
			console.warn('email-blob-delete-failed', captured.key, error)
			blobDeletions.push({ ...captured, deleted: false })
		}
	}
	return {
		messageFound: row != null,
		ownerUserId: row?.user_id ?? null,
		attachmentsSeen: attachments.length,
		externalAttachmentsSeen: attachments.filter(
			(attachment) => attachment.storage_kind === 'external',
		).length,
		blobDeletions,
	}
}

/**
 * Remove a USER Mailbox message's D1 compatibility projection after the
 * authoritative Mailbox/R2 delete has succeeded. This never touches R2 and is
 * idempotent when the projection is already absent.
 */
export async function deleteEmailMessageProjectionById(input: {
	db: D1Database
	messageId: string
	expectedUserId: string
}): Promise<{ messageDeleted: boolean }> {
	const row = await input.db
		.prepare(`SELECT user_id FROM email_messages WHERE id = ?`)
		.bind(input.messageId)
		.first<{ user_id: string }>()
	if (row == null) return { messageDeleted: false }
	if (row.user_id !== input.expectedUserId) {
		return { messageDeleted: false }
	}
	await input.db.batch([
		input.db
			.prepare(`DELETE FROM email_attachments WHERE message_id = ?`)
			.bind(input.messageId),
		input.db
			.prepare(`DELETE FROM email_messages WHERE id = ? AND user_id = ?`)
			.bind(input.messageId, input.expectedUserId),
	])
	return { messageDeleted: true }
}

/** Rows per D1 batch when inserting attachment metadata. */
const emailAttachmentInsertBatchSize = 50

export async function insertEmailAttachments(input: {
	db: D1Database
	messageId: string
	ignoreConflicts?: boolean
	inboundDeliveryFence?: EmailInboundDeliveryFence
	attachments: Array<{
		/**
		 * Pre-generated row id. Callers that store attachment bytes in R2
		 * before inserting the row pass the id embedded in the blob key.
		 */
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
	// Batched inserts keep typical attachment sets (outbound caps at ten
	// files) all-or-nothing, while chunking protects large inbound MIME
	// from oversized D1 batches. On a mid-chunk failure, callers that need
	// consistency delete by message_id, which covers earlier chunks too.
	const fence = input.inboundDeliveryFence
	const statement = input.db.prepare(
		`${input.ignoreConflicts ? 'INSERT OR IGNORE' : 'INSERT'} INTO email_attachments (
			id, message_id, filename, content_type, content_id, disposition,
			size, storage_kind, storage_key, created_at
		) ${
			fence
				? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM email_delivery_events
						WHERE id = ?
							AND user_id = ?
							AND json_extract(detail_json, '$.state') = 'storing'
							AND json_extract(detail_json, '$.storageLease') = ?
					)`
				: 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		}`,
	)
	const statements = input.attachments.map((attachment) =>
		statement.bind(
			attachment.id ?? crypto.randomUUID(),
			input.messageId,
			attachment.filename ?? null,
			attachment.contentType ?? null,
			attachment.contentId ?? null,
			attachment.disposition ?? null,
			attachment.size ?? null,
			attachment.storageKind,
			attachment.storageKey ?? null,
			timestamp,
			...(fence ? [fence.deliveryId, fence.userId, fence.storageLease] : []),
		),
	)
	for (
		let index = 0;
		index < statements.length;
		index += emailAttachmentInsertBatchSize
	) {
		await input.db.batch(
			statements.slice(index, index + emailAttachmentInsertBatchSize),
		)
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

export async function listEmailAttachmentsForUserMessage(input: {
	db: D1Database
	userId: string
	messageId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT attachment.*
			FROM email_attachments attachment
			JOIN email_messages message ON message.id = attachment.message_id
			WHERE attachment.message_id = ?
				AND message.user_id = ?
			ORDER BY attachment.created_at ASC, attachment.id ASC`,
		)
		.bind(input.messageId, input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapAttachmentRow)
}

export async function getEmailAttachmentRecordById(input: {
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
	return row ? mapAttachmentRow(row) : null
}

export async function insertEmailDeliveryEvent(input: {
	db: D1Database
	messageId?: string | null
	userId?: string | null
	inboxId?: string | null
	eventType: EmailDeliveryEventType
	provider?: string | null
	providerMessageId?: string | null
	providerEventId?: string | null
	detail?: Record<string, unknown> | null
	createdAt?: string
}): Promise<EmailDeliveryEventRecord> {
	const id = crypto.randomUUID()
	const createdAt = input.createdAt ?? nowIso()
	const detailJson = JSON.stringify(input.detail ?? {})
	const record: EmailDeliveryEventRecord = {
		id,
		messageId: input.messageId ?? null,
		userId: input.userId ?? null,
		inboxId: input.inboxId ?? null,
		eventType: input.eventType,
		provider: input.provider ?? null,
		providerMessageId: input.providerMessageId ?? null,
		providerEventId: input.providerEventId ?? null,
		detailJson,
		createdAt,
	}
	await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider,
				provider_message_id, provider_event_id, detail_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			record.id,
			record.messageId,
			record.userId,
			record.inboxId,
			record.eventType,
			record.provider,
			record.providerMessageId,
			record.providerEventId,
			record.detailJson,
			record.createdAt,
		)
		.run()
	return record
}
