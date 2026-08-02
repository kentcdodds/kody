import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxClassification,
	assertMailboxDeliveryStatus,
	assertMailboxDirection,
	assertMailboxNonEmptyString,
	assertMailboxProcessingStatus,
	assertMailboxStorageKind,
	assertOptionalMailboxCanonicalIsoTimestamp,
	decodeMailboxListCursor,
	encodeMailboxListCursor,
	mailboxNowIso,
	normalizeMailboxOffset,
	normalizeMailboxPageSize,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxCountMessagesInput,
	type MailboxCountResult,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxListMessagesInput,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxSearchMessagesInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
} from './mailbox-types.ts'
import {
	type EmailClassification,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailProcessingStatus,
} from './types.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	boundedEmailBody,
	escapeLikePattern,
	mapMailboxAttachmentRow,
	mapMailboxMessageRow,
	mapMailboxThreadRow,
} from './mailbox-mappers.ts'
import {
	deliveryEventOwnsMessage,
	hasExpiredMailboxDeliveryEvents,
	listMailboxDeliveryEvents,
	oldestMailboxDeliveryEventCreatedAt,
	pruneExpiredMailboxDeliveryEvents,
	writeMailboxDeliveryEventRow,
} from './mailbox-delivery-events.ts'
import {
	exportMailboxFromStore,
	listMailboxBlobReferences,
} from './mailbox-export.ts'
import { initializeMailboxSchema } from './mailbox-schema.ts'

export type MailboxUpsertResult = {
	created: boolean
	accepted: boolean
}

function buildMailboxMessageFilterClauses(input: {
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	query?: string | null
}): { clauses: Array<string>; params: Array<SqlStorageValue> } {
	const clauses: Array<string> = ['1 = 1']
	const params: Array<SqlStorageValue> = []
	if (typeof input.query === 'string') {
		const pattern = `%${escapeLikePattern(input.query.trim().toLowerCase())}%`
		clauses.push(`(
			LOWER(subject) LIKE ? ESCAPE '\\'
			OR LOWER(from_address) LIKE ? ESCAPE '\\'
			OR LOWER(COALESCE(envelope_from, '')) LIKE ? ESCAPE '\\'
		)`)
		params.push(pattern, pattern, pattern)
	}
	if (input.inboxId) {
		clauses.push('inbox_id = ?')
		params.push(input.inboxId)
	}
	if (input.direction) {
		clauses.push('direction = ?')
		params.push(assertMailboxDirection(input.direction))
	}
	if (input.processingStatus) {
		clauses.push('processing_status = ?')
		params.push(assertMailboxProcessingStatus(input.processingStatus))
	}
	if (input.deliveryStatus) {
		clauses.push('delivery_status = ?')
		params.push(assertMailboxDeliveryStatus(input.deliveryStatus))
	}
	if (input.classification) {
		clauses.push('classification = ?')
		params.push(assertMailboxClassification(input.classification))
	}
	return { clauses, params }
}

/**
 * SQLite write/query helpers for one Mailbox DO. No alarm / R2 side effects.
 *
 * USER inbound ledger/effect CAS helpers live in
 * `mailbox-inbound-ledger.ts` / `mailbox-inbound-effect-ledger.ts` and are
 * authoritative. Generic mirror upserts are fenced from USER inbound providers;
 * only the missing-row bootstrap bridge may insert those snapshots.
 */
export class MailboxStore {
	private readonly storage: DurableObjectStorage

	constructor(storage: DurableObjectStorage) {
		this.storage = storage
	}

	private get sql() {
		return this.storage.sql
	}

	initializeSchema() {
		initializeMailboxSchema(this.storage)
	}

	getOwnerId(): string | null {
		const row = this.sql
			.exec<{ owner_id: string }>(
				`SELECT owner_id FROM mailbox_owner_identity
				WHERE singleton = 1
				LIMIT 1`,
			)
			.toArray()[0]
		return row?.owner_id ?? null
	}

	/**
	 * Persist owner once; reject cross-user writes. DO name is not
	 * introspectable — see mailbox_owner_identity DDL comment.
	 */
	assertOwner(ownerId: string): string {
		const id = assertMailboxNonEmptyString(ownerId, 'ownerId')
		const existing = this.getOwnerId()
		if (existing == null) {
			this.sql.exec(
				`INSERT INTO mailbox_owner_identity (singleton, owner_id)
				VALUES (1, ?)`,
				id,
			)
			return id
		}
		if (existing !== id) {
			throw new Error(
				`Mailbox ownerId mismatch; this object is bound to a different owner.`,
			)
		}
		return id
	}

	validateMessageBlobKeys(input: {
		ownerId: string
		message: MailboxMessageInput
		attachments?: Array<MailboxAttachmentInput>
	}) {
		const messageId = assertMailboxNonEmptyString(
			input.message.id,
			'message.id',
		)
		const direction = assertMailboxDirection(input.message.direction)
		const rawMimeKey = input.message.rawMimeKey
		if (direction === 'inbound') {
			const expected = emailRawMimeKey(input.ownerId, messageId)
			if (rawMimeKey !== expected) {
				throw new Error(
					`Mailbox inbound rawMimeKey must equal emailRawMimeKey(ownerId, messageId).`,
				)
			}
		} else if (rawMimeKey != null) {
			const expected = emailRawMimeKey(input.ownerId, messageId)
			if (rawMimeKey !== expected) {
				throw new Error(
					`Mailbox outbound rawMimeKey must be null or equal emailRawMimeKey(ownerId, messageId).`,
				)
			}
		}

		if (input.attachments === undefined) return
		for (const attachment of input.attachments) {
			const attachmentId = assertMailboxNonEmptyString(
				attachment.id,
				'attachment.id',
			)
			const storageKind = assertMailboxStorageKind(attachment.storageKind)
			const storageKey = attachment.storageKey
			if (storageKind === 'external') {
				const expected = emailAttachmentBlobKey(
					input.ownerId,
					messageId,
					attachmentId,
				)
				if (storageKey !== expected) {
					throw new Error(
						`Mailbox external attachment storageKey must equal emailAttachmentBlobKey(ownerId, messageId, attachmentId).`,
					)
				}
			} else if (storageKey != null) {
				throw new Error(
					`Mailbox ${storageKind} attachment storageKey must be null.`,
				)
			}
		}
	}

	upsertThreadRow(thread: MailboxThreadInput): MailboxUpsertResult {
		const id = assertMailboxNonEmptyString(thread.id, 'thread.id')
		const lastMessageAt = assertMailboxCanonicalIsoTimestamp(
			thread.lastMessageAt,
			'thread.lastMessageAt',
		)
		const createdAt = assertMailboxCanonicalIsoTimestamp(
			thread.createdAt,
			'thread.createdAt',
		)
		const updatedAt = assertMailboxCanonicalIsoTimestamp(
			thread.updatedAt,
			'thread.updatedAt',
		)
		const existing = this.sql
			.exec<{ updated_at: string }>(
				`SELECT updated_at FROM email_threads WHERE id = ? LIMIT 1`,
				id,
			)
			.toArray()[0]
		if (existing && updatedAt < existing.updated_at) {
			return { created: false, accepted: false }
		}
		this.sql.exec(
			`INSERT INTO email_threads (
				id, inbox_id, subject_normalized, root_message_id_header,
				last_message_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				inbox_id = excluded.inbox_id,
				subject_normalized = excluded.subject_normalized,
				root_message_id_header = excluded.root_message_id_header,
				last_message_at = excluded.last_message_at,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at >= email_threads.updated_at`,
			id,
			thread.inboxId,
			thread.subjectNormalized,
			thread.rootMessageIdHeader,
			lastMessageAt,
			createdAt,
			updatedAt,
		)
		return { created: existing == null, accepted: true }
	}

	/**
	 * Upsert message metadata. Whole-row updates require equal/newer
	 * `updatedAt`. Delivery status remains monotonic by `delivery_status_at`
	 * within an accepted snapshot.
	 */
	upsertMessageRow(message: MailboxMessageInput): MailboxUpsertResult {
		const id = assertMailboxNonEmptyString(message.id, 'message.id')
		const direction = assertMailboxDirection(message.direction)
		const processingStatus = assertMailboxProcessingStatus(
			message.processingStatus,
		)
		const classification = assertMailboxClassification(message.classification)
		const deliveryStatus =
			message.deliveryStatus == null
				? null
				: assertMailboxDeliveryStatus(message.deliveryStatus)
		const deliveryStatusAt = assertOptionalMailboxCanonicalIsoTimestamp(
			message.deliveryStatusAt,
			'message.deliveryStatusAt',
		)
		if (deliveryStatus != null && deliveryStatusAt == null) {
			throw new Error(
				'Mailbox message.deliveryStatusAt is required when deliveryStatus is set.',
			)
		}
		const createdAt = assertMailboxCanonicalIsoTimestamp(
			message.createdAt,
			'message.createdAt',
		)
		const updatedAt = assertMailboxCanonicalIsoTimestamp(
			message.updatedAt,
			'message.updatedAt',
		)
		const receivedAt = assertOptionalMailboxCanonicalIsoTimestamp(
			message.receivedAt,
			'message.receivedAt',
		)
		const sentAt = assertOptionalMailboxCanonicalIsoTimestamp(
			message.sentAt,
			'message.sentAt',
		)
		const existing = this.sql
			.exec<{ updated_at: string }>(
				`SELECT updated_at FROM email_messages WHERE id = ? LIMIT 1`,
				id,
			)
			.toArray()[0]
		if (existing && updatedAt < existing.updated_at) {
			return { created: false, accepted: false }
		}
		this.sql.exec(
			`INSERT INTO email_messages (
				id, direction, inbox_id, thread_id, sender_identity_id,
				from_address, envelope_from, to_addresses_json, cc_addresses_json,
				bcc_addresses_json, reply_to_addresses_json, subject,
				message_id_header, in_reply_to_header, references_json, headers_json,
				auth_results, text_body, html_body, raw_mime_key, raw_size,
				processing_status, classification, classification_reason,
				provider_message_id, delivery_status, delivery_status_at, error,
				received_at, sent_at, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT(id) DO UPDATE SET
				direction = excluded.direction,
				inbox_id = excluded.inbox_id,
				thread_id = excluded.thread_id,
				sender_identity_id = excluded.sender_identity_id,
				from_address = excluded.from_address,
				envelope_from = excluded.envelope_from,
				to_addresses_json = excluded.to_addresses_json,
				cc_addresses_json = excluded.cc_addresses_json,
				bcc_addresses_json = excluded.bcc_addresses_json,
				reply_to_addresses_json = excluded.reply_to_addresses_json,
				subject = excluded.subject,
				message_id_header = excluded.message_id_header,
				in_reply_to_header = excluded.in_reply_to_header,
				references_json = excluded.references_json,
				headers_json = excluded.headers_json,
				auth_results = excluded.auth_results,
				text_body = excluded.text_body,
				html_body = excluded.html_body,
				raw_mime_key = excluded.raw_mime_key,
				raw_size = excluded.raw_size,
				processing_status = excluded.processing_status,
				classification = excluded.classification,
				classification_reason = excluded.classification_reason,
				provider_message_id = excluded.provider_message_id,
				delivery_status = CASE
					WHEN excluded.delivery_status_at IS NULL
						THEN email_messages.delivery_status
					WHEN email_messages.delivery_status_at IS NULL
						THEN excluded.delivery_status
					WHEN excluded.delivery_status_at >= email_messages.delivery_status_at
						THEN excluded.delivery_status
					ELSE email_messages.delivery_status
				END,
				delivery_status_at = CASE
					WHEN excluded.delivery_status_at IS NULL
						THEN email_messages.delivery_status_at
					WHEN email_messages.delivery_status_at IS NULL
						THEN excluded.delivery_status_at
					WHEN excluded.delivery_status_at >= email_messages.delivery_status_at
						THEN excluded.delivery_status_at
					ELSE email_messages.delivery_status_at
				END,
				error = excluded.error,
				received_at = excluded.received_at,
				sent_at = excluded.sent_at,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at >= email_messages.updated_at`,
			id,
			direction,
			message.inboxId,
			message.threadId,
			message.senderIdentityId,
			message.fromAddress,
			message.envelopeFrom,
			JSON.stringify(message.toAddresses),
			JSON.stringify(message.ccAddresses),
			JSON.stringify(message.bccAddresses),
			JSON.stringify(message.replyToAddresses),
			message.subject,
			message.messageIdHeader,
			message.inReplyToHeader,
			JSON.stringify(message.references),
			JSON.stringify(message.headers),
			message.authResults,
			boundedEmailBody(message.textBody),
			boundedEmailBody(message.htmlBody),
			message.rawMimeKey,
			message.rawSize,
			processingStatus,
			classification,
			message.classificationReason,
			message.providerMessageId,
			deliveryStatus,
			deliveryStatusAt,
			message.error,
			receivedAt,
			sentAt,
			createdAt,
			updatedAt,
		)
		return { created: existing == null, accepted: true }
	}

	replaceAttachmentsForMessage(
		messageId: string,
		attachments: Array<MailboxAttachmentInput>,
	) {
		this.sql.exec(
			`DELETE FROM email_attachments WHERE message_id = ?`,
			messageId,
		)
		for (const attachment of attachments) {
			const id = assertMailboxNonEmptyString(attachment.id, 'attachment.id')
			const attachmentMessageId = assertMailboxNonEmptyString(
				attachment.messageId,
				'attachment.messageId',
			)
			if (attachmentMessageId !== messageId) {
				throw new Error(
					'Mailbox attachment.messageId must match the mirrored message id.',
				)
			}
			const storageKind = assertMailboxStorageKind(attachment.storageKind)
			const createdAt = assertMailboxCanonicalIsoTimestamp(
				attachment.createdAt,
				'attachment.createdAt',
			)
			if (!Number.isFinite(attachment.size)) {
				throw new Error('Mailbox attachment.size must be a finite number.')
			}
			this.sql.exec(
				`INSERT INTO email_attachments (
					id, message_id, filename, content_type, content_id, disposition,
					size, storage_kind, storage_key, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				attachmentMessageId,
				attachment.filename,
				attachment.contentType,
				attachment.contentId,
				attachment.disposition,
				Math.trunc(attachment.size),
				storageKind,
				attachment.storageKey,
				createdAt,
			)
		}
	}

	writeDeliveryEventRow(event: MailboxDeliveryEventInput): {
		inserted: boolean
		accepted: boolean
	} {
		return writeMailboxDeliveryEventRow(this.sql, event)
	}

	updateLatestDeliveryStatus(input: {
		messageId: string
		deliveryStatus: EmailDeliveryStatus
		deliveryStatusAt: string
	}): boolean {
		const messageId = assertMailboxNonEmptyString(input.messageId, 'messageId')
		const deliveryStatus = assertMailboxDeliveryStatus(input.deliveryStatus)
		const deliveryStatusAt = assertMailboxCanonicalIsoTimestamp(
			input.deliveryStatusAt,
			'deliveryStatusAt',
		)
		const cursor = this.sql.exec(
			`UPDATE email_messages
			SET delivery_status = ?,
				delivery_status_at = ?,
				updated_at = ?
			WHERE id = ?
				AND (delivery_status_at IS NULL OR delivery_status_at <= ?)`,
			deliveryStatus,
			deliveryStatusAt,
			mailboxNowIso(),
			messageId,
			deliveryStatusAt,
		)
		return cursor.rowsWritten > 0
	}

	deliveryEventOwnsMessage(eventId: string, messageId: string) {
		return deliveryEventOwnsMessage(this.sql, eventId, messageId)
	}

	getThread(threadId: string): MailboxThreadRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_threads WHERE id = ? LIMIT 1`,
				assertMailboxNonEmptyString(threadId, 'threadId'),
			)
			.toArray()[0]
		return row ? mapMailboxThreadRow(row) : null
	}

	getMessage(messageId: string): MailboxMessageRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages WHERE id = ? LIMIT 1`,
				assertMailboxNonEmptyString(messageId, 'messageId'),
			)
			.toArray()[0]
		return row ? mapMailboxMessageRow(row) : null
	}

	getMessageByMessageIdHeader(
		messageIdHeader: string,
	): MailboxMessageRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE message_id_header = ?
				LIMIT 1`,
				assertMailboxNonEmptyString(messageIdHeader, 'messageIdHeader'),
			)
			.toArray()[0]
		return row ? mapMailboxMessageRow(row) : null
	}

	getOutboundMessageByProviderMessageId(
		providerMessageId: string,
	): MailboxMessageRecord | null {
		const id = assertMailboxNonEmptyString(
			providerMessageId,
			'providerMessageId',
		)
		const rows = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE direction = 'outbound' AND provider_message_id = ?
				LIMIT 2`,
				id,
			)
			.toArray()
		if (rows.length > 1) {
			throw new Error(
				`Multiple outbound email messages share provider id: ${id}`,
			)
		}
		const row = rows[0]
		return row ? mapMailboxMessageRow(row) : null
	}

	listMessages(input: MailboxListMessagesInput): {
		messages: Array<MailboxMessageRecord>
		nextCursor: string | null
	} {
		const limit = normalizeMailboxPageSize(input.limit)
		const { clauses, params } = buildMailboxMessageFilterClauses(input)
		if (input.cursor) {
			const cursor = decodeMailboxListCursor(input.cursor)
			clauses.push('(created_at, id) < (?, ?)')
			params.push(cursor.createdAt, cursor.id)
		}
		const offset =
			input.cursor == null ? normalizeMailboxOffset(input.offset) : 0
		params.push(limit + 1, offset)
		const rows = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ? OFFSET ?`,
				...params,
			)
			.toArray()
		const hasMore = rows.length > limit
		const pageRows = hasMore ? rows.slice(0, limit) : rows
		const last = pageRows[pageRows.length - 1]
		return {
			messages: pageRows.map(mapMailboxMessageRow),
			nextCursor:
				hasMore && last
					? encodeMailboxListCursor({
							createdAt: String(last['created_at']),
							id: String(last['id']),
						})
					: null,
		}
	}

	searchMessages(input: MailboxSearchMessagesInput): {
		messages: Array<MailboxMessageRecord>
	} {
		if (typeof input.query !== 'string') {
			throw new Error('Mailbox search query must be a string.')
		}
		const limit = normalizeMailboxPageSize(input.limit)
		const offset = normalizeMailboxOffset(input.offset)
		const { clauses, params } = buildMailboxMessageFilterClauses({
			...input,
			query: input.query,
		})
		params.push(limit, offset)
		const rows = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ? OFFSET ?`,
				...params,
			)
			.toArray()
		return { messages: rows.map(mapMailboxMessageRow) }
	}

	countMessages(input: MailboxCountMessagesInput): { total: number } {
		const { clauses, params } = buildMailboxMessageFilterClauses(input)
		const row = this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM email_messages
				WHERE ${clauses.join(' AND ')}`,
				...params,
			)
			.one()
		return { total: Number(row.n ?? 0) || 0 }
	}

	getAttachment(attachmentId: string): MailboxAttachmentRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_attachments WHERE id = ? LIMIT 1`,
				assertMailboxNonEmptyString(attachmentId, 'attachmentId'),
			)
			.toArray()[0]
		return row ? mapMailboxAttachmentRow(row) : null
	}

	listAttachmentsForMessage(messageId: string): Array<MailboxAttachmentRecord> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_attachments
				WHERE message_id = ?
				ORDER BY created_at ASC, id ASC`,
				assertMailboxNonEmptyString(messageId, 'messageId'),
			)
			.toArray()
			.map(mapMailboxAttachmentRow)
	}

	listDeliveryEvents(input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	}): Array<MailboxDeliveryEventRecord> {
		return listMailboxDeliveryEvents(this.sql, input)
	}

	countMailbox(): MailboxCountResult {
		const threads = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_threads`)
			.one()
		const messages = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_messages`)
			.one()
		const attachments = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_attachments`)
			.one()
		const deliveryEvents = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_delivery_events`)
			.one()
		return {
			threads: Number(threads.n ?? 0) || 0,
			messages: Number(messages.n ?? 0) || 0,
			attachments: Number(attachments.n ?? 0) || 0,
			deliveryEvents: Number(deliveryEvents.n ?? 0) || 0,
		}
	}

	exportMailbox(input: {
		pageSize?: number
		startAfter?: string | null
	}): MailboxExportResult {
		return exportMailboxFromStore(this.sql, input)
	}

	listBlobReferences(input: {
		pageSize?: number
		startAfter?: string | null
	}): MailboxBlobReferencePage {
		return listMailboxBlobReferences(this.sql, {
			ownerId: this.getOwnerId(),
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	oldestMessageCreatedAt(): string | null {
		const row = this.sql
			.exec<{ created_at: string }>(
				`SELECT created_at FROM email_messages
				ORDER BY created_at ASC, id ASC
				LIMIT 1`,
			)
			.toArray()[0]
		return row?.created_at ?? null
	}

	oldestDeliveryEventCreatedAt(): string | null {
		return oldestMailboxDeliveryEventCreatedAt(this.sql)
	}

	listExpiredMessagesForRetention(input: {
		cutoff: string
		limit: number
	}): Array<{
		id: string
		direction: EmailDirection
		created_at: string
	}> {
		return this.sql
			.exec<{
				id: string
				direction: EmailDirection
				created_at: string
			}>(
				`SELECT id, direction, created_at FROM email_messages
				WHERE created_at < ?
				ORDER BY created_at ASC, id ASC
				LIMIT ?`,
				input.cutoff,
				input.limit,
			)
			.toArray()
	}

	listAttachmentsForRetention(
		messageIds: Array<string>,
	): Array<{ id: string; message_id: string; storage_key: string | null }> {
		if (messageIds.length === 0) return []
		return this.sql
			.exec<{
				id: string
				message_id: string
				storage_key: string | null
			}>(
				`SELECT id, message_id, storage_key FROM email_attachments
				WHERE message_id IN (${messageIds.map(() => '?').join(', ')})`,
				...messageIds,
			)
			.toArray()
	}

	deleteMessageCascade(messageId: string) {
		this.sql.exec(
			`DELETE FROM email_attachments WHERE message_id = ?`,
			messageId,
		)
		this.sql.exec(`DELETE FROM email_messages WHERE id = ?`, messageId)
	}

	pruneExpiredDeliveryEvents(input: { cutoff: string; limit: number }) {
		pruneExpiredMailboxDeliveryEvents(this.sql, input)
	}

	hasExpiredMessages(cutoff: string): boolean {
		return (
			this.sql
				.exec<{ ok: number }>(
					`SELECT 1 AS ok FROM email_messages
					WHERE created_at < ?
					LIMIT 1`,
					cutoff,
				)
				.toArray()[0] != null
		)
	}

	hasExpiredDeliveryEvents(cutoff: string): boolean {
		return hasExpiredMailboxDeliveryEvents(this.sql, cutoff)
	}

	pruneOrphanThreads(limit: number) {
		this.sql.exec(
			`DELETE FROM email_threads
			WHERE id IN (
				SELECT thread.id FROM email_threads thread
				WHERE NOT EXISTS (
					SELECT 1 FROM email_messages message
					WHERE message.thread_id = thread.id
				)
				ORDER BY thread.created_at ASC, thread.id ASC
				LIMIT ?
			)`,
			limit,
		)
	}
}
