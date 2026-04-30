import {
	type EmailAttachmentRecord,
	type EmailDirection,
	type EmailDeliveryEventType,
	type EmailInboxAddressRecord,
	type EmailInboxMode,
	type EmailInboxRecord,
	type EmailMessageRecord,
	type EmailPolicyDecision,
	type EmailProcessingStatus,
	type EmailSenderIdentityRecord,
	type EmailPolicyEffect,
	type EmailPolicyKind,
	type EmailSenderPolicyRecord,
	type EmailThreadRecord,
} from './types.ts'

type D1RunResult = Awaited<ReturnType<D1PreparedStatement['run']>>

function nowIso() {
	return new Date().toISOString()
}

function normalizeRunChanges(result: D1RunResult) {
	const changes = result.meta['changes']
	return typeof changes === 'number' ? changes : Number(changes ?? 0)
}

function parseJsonArray(value: string | null) {
	if (!value) return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

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
		mode: String(row['mode']) as EmailInboxMode,
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
		replyTokenHash:
			row['reply_token_hash'] == null ? null : String(row['reply_token_hash']),
		enabled: Number(row['enabled']) === 1,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapSenderIdentityRow(
	row: Record<string, unknown>,
): EmailSenderIdentityRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		email: String(row['email']),
		domain: String(row['domain']),
		displayName:
			row['display_name'] == null ? null : String(row['display_name']),
		status: String(row['status']) as EmailSenderIdentityRecord['status'],
		verifiedAt:
			row['verified_at'] == null ? null : String(row['verified_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapSenderPolicyRow(
	row: Record<string, unknown>,
): EmailSenderPolicyRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		inboxId: row['inbox_id'] == null ? null : String(row['inbox_id']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		kind: String(row['kind']) as EmailPolicyKind,
		value: String(row['value']),
		effect: String(row['effect']) as EmailPolicyEffect,
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
		toAddresses: parseJsonArray(String(row['to_addresses_json'] ?? '[]')).filter(
			(value): value is string => typeof value === 'string',
		),
		ccAddresses: parseJsonArray(String(row['cc_addresses_json'] ?? '[]')).filter(
			(value): value is string => typeof value === 'string',
		),
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
		policyDecision: String(row['policy_decision']) as EmailPolicyDecision,
		processingStatus: String(
			row['processing_status'],
		) as EmailProcessingStatus,
		providerMessageId:
			row['provider_message_id'] == null
				? null
				: String(row['provider_message_id']),
		error: row['error'] == null ? null : String(row['error']),
		receivedAt:
			row['received_at'] == null ? null : String(row['received_at']),
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
		disposition:
			row['disposition'] == null ? null : String(row['disposition']),
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
	mode: EmailInboxMode
	packageId?: string | null
}) {
	const timestamp = nowIso()
	const row = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		package_id: input.packageId ?? null,
		name: input.name,
		description: input.description ?? null,
		mode: input.mode,
		enabled: 1,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, package_id, name, description, mode, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.package_id,
			row.name,
			row.description,
			row.mode,
			row.enabled,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapInboxRow(row)
}

export async function createEmailInboxAddress(input: {
	db: D1Database
	inboxId: string
	userId: string
	address: string
	localPart: string
	domain: string
	replyTokenHash?: string | null
}) {
	const timestamp = nowIso()
	const row = {
		id: crypto.randomUUID(),
		inbox_id: input.inboxId,
		user_id: input.userId,
		address: input.address,
		local_part: input.localPart,
		domain: input.domain,
		reply_token_hash: input.replyTokenHash ?? null,
		enabled: 1,
		created_at: timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_inbox_addresses (
				id, inbox_id, user_id, address, local_part, domain, reply_token_hash, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.inbox_id,
			row.user_id,
			row.address,
			row.local_part,
			row.domain,
			row.reply_token_hash,
			row.enabled,
			row.created_at,
			row.updated_at,
		)
		.run()
	return mapInboxAddressRow(row)
}

export async function deleteEmailInboxById(input: {
	db: D1Database
	inboxId: string
}) {
	await input.db
		.prepare(
			`DELETE FROM email_inboxes
			WHERE id = ?`,
		)
		.bind(input.inboxId)
		.run()
}

export async function createEmailInboxWithAddress(input: {
	db: D1Database
	userId: string
	name: string
	description?: string | null
	mode: EmailInboxMode
	packageId?: string | null
	address: string
	localPart: string
	domain: string
	replyTokenHash?: string | null
}) {
	const inbox = await createEmailInbox({
		db: input.db,
		userId: input.userId,
		name: input.name,
		description: input.description ?? null,
		mode: input.mode,
		packageId: input.packageId ?? null,
	})
	try {
		const address = await createEmailInboxAddress({
			db: input.db,
			inboxId: inbox.id,
			userId: input.userId,
			address: input.address,
			localPart: input.localPart,
			domain: input.domain,
			replyTokenHash: input.replyTokenHash ?? null,
		})
		return { inbox, address }
	} catch (error) {
		await deleteEmailInboxById({
			db: input.db,
			inboxId: inbox.id,
		}).catch(() => undefined)
		throw error
	}
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

export async function getEmailInboxAddressByAddress(input: {
	db: D1Database
	address: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inbox_addresses
			WHERE address = ?
				AND enabled = 1
			LIMIT 1`,
		)
		.bind(input.address)
		.first<Record<string, unknown>>()
	return row ? mapInboxAddressRow(row) : null
}

export async function getEmailInboxAddressByReplyTokenHash(input: {
	db: D1Database
	replyTokenHash: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM email_inbox_addresses
			WHERE reply_token_hash = ?
				AND enabled = 1
			LIMIT 1`,
		)
		.bind(input.replyTokenHash)
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

export async function upsertEmailSenderIdentity(input: {
	db: D1Database
	userId: string
	email: string
	domain: string
	displayName?: string | null
	status?: EmailSenderIdentityRecord['status']
	verifiedAt?: string | null
	packageId?: string | null
}) {
	const existing = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_identities
			WHERE user_id = ?
				AND email = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.email)
		.first<Record<string, unknown>>()
	const timestamp = nowIso()
	const row = {
		id: existing ? String(existing['id']) : crypto.randomUUID(),
		user_id: input.userId,
		package_id: input.packageId ?? null,
		email: input.email,
		domain: input.domain,
		display_name: input.displayName ?? '',
		status: input.status ?? 'verified',
		verified_at: input.verifiedAt ?? timestamp,
		created_at: existing ? String(existing['created_at']) : timestamp,
		updated_at: timestamp,
	}
	await input.db
		.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, package_id, email, domain, display_name, status, verified_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, email) DO UPDATE SET
				package_id = excluded.package_id,
				domain = excluded.domain,
				display_name = excluded.display_name,
				status = excluded.status,
				verified_at = excluded.verified_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			row.id,
			row.user_id,
			row.package_id,
			row.email,
			row.domain,
			row.display_name,
			row.status,
			row.verified_at,
			row.created_at,
			row.updated_at,
		)
		.run()
	const persisted = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_identities
			WHERE user_id = ?
				AND email = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.email)
		.first<Record<string, unknown>>()
	if (!persisted) {
		throw new Error('Failed to read saved sender identity.')
	}
	return mapSenderIdentityRow(persisted)
}

export async function getVerifiedSenderIdentity(input: {
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
				AND status = 'verified'
			LIMIT 1`,
		)
		.bind(input.userId, input.email)
		.first<Record<string, unknown>>()
	return row ? mapSenderIdentityRow(row) : null
}

export async function upsertEmailSenderPolicy(input: {
	db: D1Database
	userId: string
	kind: EmailPolicyKind
	value: string
	effect: EmailPolicyEffect
	inboxId?: string | null
	packageId?: string | null
}) {
	const existing = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_policies
			WHERE user_id = ?
				AND kind = ?
				AND value = ?
				AND COALESCE(inbox_id, '') = COALESCE(?, '')
				AND COALESCE(package_id, '') = COALESCE(?, '')
			LIMIT 1`,
		)
		.bind(
			input.userId,
			input.kind,
			input.value,
			input.inboxId ?? null,
			input.packageId ?? null,
		)
		.first<Record<string, unknown>>()
	const timestamp = nowIso()
	const row = {
		id: existing ? String(existing['id']) : crypto.randomUUID(),
		user_id: input.userId,
		inbox_id: input.inboxId ?? null,
		package_id: input.packageId ?? null,
		kind: input.kind,
		value: input.value,
		effect: input.effect,
		enabled: 1,
		created_at: existing ? String(existing['created_at']) : timestamp,
		updated_at: timestamp,
	}
	if (existing) {
		await input.db
			.prepare(
				`UPDATE email_sender_policies
				SET effect = ?,
					enabled = 1,
					updated_at = ?
				WHERE id = ?`,
			)
			.bind(row.effect, row.updated_at, row.id)
			.run()
	} else {
		await input.db
			.prepare(
				`INSERT INTO email_sender_policies (
					id, user_id, inbox_id, package_id, kind, value, effect, enabled, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				row.id,
				row.user_id,
				row.inbox_id,
				row.package_id,
				row.kind,
				row.value,
				row.effect,
				row.enabled,
				row.created_at,
				row.updated_at,
			)
			.run()
	}
	return mapSenderPolicyRow(row)
}

export async function disableEmailSenderPolicy(input: {
	db: D1Database
	userId: string
	kind: EmailPolicyKind
	value: string
	inboxId?: string | null
	packageId?: string | null
}) {
	const result = await input.db
		.prepare(
			`UPDATE email_sender_policies
			SET enabled = 0,
				updated_at = ?
			WHERE user_id = ?
				AND kind = ?
				AND value = ?
				AND COALESCE(inbox_id, '') = COALESCE(?, '')
				AND COALESCE(package_id, '') = COALESCE(?, '')`,
		)
		.bind(
			nowIso(),
			input.userId,
			input.kind,
			input.value,
			input.inboxId ?? null,
			input.packageId ?? null,
		)
		.run()
	return normalizeRunChanges(result) > 0
}

export async function listEmailSenderPolicies(input: {
	db: D1Database
	userId: string
	inboxId?: string | null
	includeDisabled?: boolean
}) {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM email_sender_policies
			WHERE user_id = ?
				AND (? IS NULL OR inbox_id IS NULL OR inbox_id = ?)
				AND (? = 1 OR enabled = 1)
			ORDER BY inbox_id DESC, kind ASC, value ASC`,
		)
		.bind(
			input.userId,
			input.inboxId ?? null,
			input.inboxId ?? null,
			input.includeDisabled ? 1 : 0,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapSenderPolicyRow)
}

export async function findThreadForMessage(input: {
	db: D1Database
	userId: string
	inboxId?: string | null
	references: Array<string>
	inReplyToHeader?: string | null
	subjectNormalized?: string | null
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
	if (input.subjectNormalized?.trim()) {
		const row = await input.db
			.prepare(
				`SELECT *
				FROM email_threads
				WHERE user_id = ?
					AND (? IS NULL OR inbox_id = ?)
					AND subject_normalized = ?
				ORDER BY last_message_at DESC, id DESC
				LIMIT 1`,
			)
			.bind(
				input.userId,
				input.inboxId ?? null,
				input.inboxId ?? null,
				input.subjectNormalized,
			)
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
		policyDecision: EmailPolicyDecision
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
		policy_decision: input.message.policyDecision,
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
				text_body, html_body, raw_mime, raw_size, policy_decision,
				processing_status, provider_message_id, error, received_at, sent_at,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			row.policy_decision,
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
	policyDecision?: EmailPolicyDecision | null
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
				AND (? IS NULL OR policy_decision = ?)
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
			input.policyDecision ?? null,
			input.policyDecision ?? null,
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

