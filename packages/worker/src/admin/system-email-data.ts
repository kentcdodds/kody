import { readPagination } from '#worker/query-params.ts'
// Type-only: see the note in users-data.ts.
import { type AdminSystemEmailLoaderData } from '#app/loader-data.ts'
import { loadRawMime } from '#worker/email/service.ts'
import {
	systemEmailLimits,
	systemEmailLocals,
	systemEmailOwnerId,
} from '#worker/email/system-email.ts'

export const adminSystemEmailListItemFieldNames = [
	'id',
	'inbox_local_part',
	'from_address',
	'envelope_from',
	'subject',
	'processing_status',
	'raw_size',
	'received_at',
	'created_at',
] as const

type AdminSystemEmailListItemFieldName =
	(typeof adminSystemEmailListItemFieldNames)[number]

export type AdminSystemEmailListItem = Record<
	AdminSystemEmailListItemFieldName,
	unknown
> & {
	id: string
	inbox_local_part: string
	from_address: string | null
	envelope_from: string | null
	subject: string | null
	processing_status: string
	raw_size: number
	received_at: string | null
	created_at: string
}

export type AdminSystemEmailDetail = AdminSystemEmailListItem & {
	to_addresses: Array<string>
	cc_addresses: Array<string>
	reply_to_addresses: Array<string>
	headers: Record<string, Array<string>>
	text_body: string | null
	html_body: string | null
	raw_mime: string | null
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		created_at: string
	}>
}

const defaultPageSize = 25
const maxPageSize = 100

// Corrupt stored JSON degrades to empty values instead of crashing the
// admin mail views.
function parseJsonSafe(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

function parseStringArray(value: string | null) {
	if (!value) return []
	const parsed = parseJsonSafe(value)
	return Array.isArray(parsed)
		? parsed.filter((entry): entry is string => typeof entry === 'string')
		: []
}

function parseHeaders(value: string | null): Record<string, Array<string>> {
	if (!value) return {}
	const parsed = parseJsonSafe(value)
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
	const headers: Record<string, Array<string>> = {}
	for (const [key, headerValue] of Object.entries(parsed)) {
		if (!Array.isArray(headerValue)) continue
		headers[key] = headerValue.filter(
			(entry): entry is string => typeof entry === 'string',
		)
	}
	return headers
}

function toListItem(row: Record<string, unknown>): AdminSystemEmailListItem {
	return {
		id: String(row['id']),
		inbox_local_part: String(row['inbox_local_part'] ?? ''),
		from_address:
			row['from_address'] == null ? null : String(row['from_address']),
		envelope_from:
			row['envelope_from'] == null ? null : String(row['envelope_from']),
		subject: row['subject'] == null ? null : String(row['subject']),
		processing_status: String(row['processing_status']),
		raw_size: Number(row['raw_size'] ?? 0),
		received_at: row['received_at'] == null ? null : String(row['received_at']),
		created_at: String(row['created_at']),
	}
}

async function listAttachments(db: D1Database, messageId: string) {
	const result = await db
		.prepare(
			`SELECT id, filename, content_type, content_id, disposition, size, storage_kind, created_at
			FROM email_attachments
			WHERE message_id = ?
			ORDER BY created_at ASC, id ASC`,
		)
		.bind(messageId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map((row) => ({
		id: String(row['id']),
		filename: row['filename'] == null ? null : String(row['filename']),
		content_type:
			row['content_type'] == null ? null : String(row['content_type']),
		content_id: row['content_id'] == null ? null : String(row['content_id']),
		disposition: row['disposition'] == null ? null : String(row['disposition']),
		size: Number(row['size'] ?? 0),
		storage_kind: String(row['storage_kind']),
		created_at: String(row['created_at']),
	}))
}

export async function loadAdminSystemEmailMessageById(
	db: D1Database,
	messageId: string,
	blobs: R2Bucket,
): Promise<AdminSystemEmailDetail | null> {
	const row = await db
		.prepare(
			`SELECT message.*, address.local_part AS inbox_local_part
			FROM email_messages AS message
			LEFT JOIN email_inbox_addresses AS address
				ON address.inbox_id = message.inbox_id
				AND address.user_id = message.user_id
			WHERE message.user_id = ?
				AND message.id = ?
			LIMIT 1`,
		)
		.bind(systemEmailOwnerId, messageId)
		.first<Record<string, unknown>>()
	if (!row) return null
	return {
		...toListItem(row),
		to_addresses: parseStringArray(
			row['to_addresses_json'] == null
				? null
				: String(row['to_addresses_json']),
		),
		cc_addresses: parseStringArray(
			row['cc_addresses_json'] == null
				? null
				: String(row['cc_addresses_json']),
		),
		reply_to_addresses: parseStringArray(
			row['reply_to_addresses_json'] == null
				? null
				: String(row['reply_to_addresses_json']),
		),
		headers: parseHeaders(
			row['headers_json'] == null ? null : String(row['headers_json']),
		),
		text_body: row['text_body'] == null ? null : String(row['text_body']),
		html_body: row['html_body'] == null ? null : String(row['html_body']),
		raw_mime: await loadRawMime({
			blobs,
			message: {
				rawMimeKey:
					row['raw_mime_key'] == null ? null : String(row['raw_mime_key']),
			},
		}),
		attachments: await listAttachments(db, messageId),
	}
}

export async function loadAdminSystemEmailData(
	env: Env,
	requestUrl: string,
): Promise<AdminSystemEmailLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const { page, pageSize, offset } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	const selectedMessageId = url.searchParams.get('messageId')?.trim() || null
	const [totalResult, messageRows, selectedMessage] = await Promise.all([
		env.APP_DB.prepare(
			`SELECT COUNT(*) AS total
			FROM email_messages
			WHERE user_id = ?
				AND direction = 'inbound'`,
		)
			.bind(systemEmailOwnerId)
			.first<{ total: number }>(),
		env.APP_DB.prepare(
			`SELECT message.id, address.local_part AS inbox_local_part,
				message.from_address, message.envelope_from, message.subject,
				message.processing_status, message.raw_size, message.received_at,
				message.created_at
			FROM email_messages AS message
			LEFT JOIN email_inbox_addresses AS address
				ON address.inbox_id = message.inbox_id
				AND address.user_id = message.user_id
			WHERE message.user_id = ?
				AND message.direction = 'inbound'
			ORDER BY message.created_at DESC, message.id DESC
			LIMIT ? OFFSET ?`,
		)
			.bind(systemEmailOwnerId, pageSize, offset)
			.all<Record<string, unknown>>(),
		selectedMessageId
			? loadAdminSystemEmailMessageById(
					env.APP_DB,
					selectedMessageId,
					env.EMAIL_BLOBS,
				)
			: Promise.resolve(null),
	])
	return {
		ok: true,
		ownerId: systemEmailOwnerId,
		systemLocals: [...systemEmailLocals],
		limits: { ...systemEmailLimits },
		messages: (messageRows.results ?? []).map(toListItem),
		selectedMessage,
		page,
		pageSize,
		total: Number(totalResult?.total ?? 0),
	}
}
