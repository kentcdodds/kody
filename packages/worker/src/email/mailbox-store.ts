import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxClassification,
	assertMailboxDeliveryEventType,
	assertMailboxDeliveryStatus,
	assertMailboxDirection,
	assertMailboxInboundDeliveryState,
	assertMailboxNonEmptyString,
	assertMailboxProcessingStatus,
	assertMailboxStorageKind,
	assertMailboxSubscriptionEffectState,
	assertOptionalMailboxCanonicalIsoTimestamp,
	decodeMailboxListCursor,
	encodeMailboxListCursor,
	mailboxNowIso,
	normalizeMailboxPageSize,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
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
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
} from './types.ts'
import {
	boundedEmailBody,
	escapeLikePattern,
	mapMailboxAttachmentRow,
	mapMailboxDeliveryEventRow,
	mapMailboxMessageRow,
	mapMailboxThreadRow,
} from './mailbox-mappers.ts'
import {
	exportMailboxFromStore,
	listMailboxBlobReferences,
} from './mailbox-export.ts'
import { initializeMailboxSchema } from './mailbox-schema.ts'

/**
 * SQLite write/query helpers for one Mailbox DO. No alarm / R2 side effects.
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

	upsertThreadRow(thread: MailboxThreadInput) {
		const id = assertMailboxNonEmptyString(thread.id, 'thread.id')
		const lastMessageAt = assertMailboxCanonicalIsoTimestamp(
			thread.lastMessageAt,
			'thread.lastMessageAt',
		)
		const createdAt = assertMailboxCanonicalIsoTimestamp(
			thread.createdAt?.trim() || mailboxNowIso(),
			'thread.createdAt',
		)
		const updatedAt = assertMailboxCanonicalIsoTimestamp(
			thread.updatedAt?.trim() || mailboxNowIso(),
			'thread.updatedAt',
		)
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
				updated_at = excluded.updated_at`,
			id,
			thread.inboxId ?? null,
			thread.subjectNormalized ?? '',
			thread.rootMessageIdHeader ?? null,
			lastMessageAt,
			createdAt,
			updatedAt,
		)
	}

	/**
	 * Upsert message metadata. Delivery status is monotonic by
	 * `delivery_status_at` (`>=` / equal timestamps may update; older must not
	 * regress a newer status from dual-write replay).
	 */
	upsertMessageRow(message: MailboxMessageInput) {
		const id = assertMailboxNonEmptyString(message.id, 'message.id')
		const direction = assertMailboxDirection(message.direction)
		const processingStatus = assertMailboxProcessingStatus(
			message.processingStatus,
		)
		const classification = assertMailboxClassification(
			message.classification ?? 'accepted',
		)
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
			message.createdAt?.trim() || mailboxNowIso(),
			'message.createdAt',
		)
		const updatedAt = assertMailboxCanonicalIsoTimestamp(
			message.updatedAt?.trim() || mailboxNowIso(),
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
				updated_at = excluded.updated_at`,
			id,
			direction,
			message.inboxId ?? null,
			message.threadId ?? null,
			message.senderIdentityId ?? null,
			message.fromAddress ?? '',
			message.envelopeFrom ?? null,
			JSON.stringify(message.toAddresses ?? []),
			JSON.stringify(message.ccAddresses ?? []),
			JSON.stringify(message.bccAddresses ?? []),
			JSON.stringify(message.replyToAddresses ?? []),
			message.subject ?? '',
			message.messageIdHeader ?? null,
			message.inReplyToHeader ?? null,
			JSON.stringify(message.references ?? []),
			message.headers ? JSON.stringify(message.headers) : '{}',
			message.authResults ?? null,
			boundedEmailBody(message.textBody),
			boundedEmailBody(message.htmlBody),
			message.rawMimeKey ?? null,
			message.rawSize ?? 0,
			processingStatus,
			classification,
			message.classificationReason ?? null,
			message.providerMessageId ?? null,
			deliveryStatus,
			deliveryStatusAt,
			message.error ?? null,
			receivedAt,
			sentAt,
			createdAt,
			updatedAt,
		)
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
			const storageKind = assertMailboxStorageKind(
				String(attachment.storageKind),
			)
			const createdAt = assertMailboxCanonicalIsoTimestamp(
				attachment.createdAt?.trim() || mailboxNowIso(),
				'attachment.createdAt',
			)
			this.sql.exec(
				`INSERT INTO email_attachments (
					id, message_id, filename, content_type, content_id, disposition,
					size, storage_kind, storage_key, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				attachmentMessageId,
				attachment.filename ?? null,
				attachment.contentType ?? 'application/octet-stream',
				attachment.contentId ?? null,
				attachment.disposition ?? null,
				Math.max(0, Math.trunc(Number(attachment.size) || 0)),
				storageKind,
				attachment.storageKey ?? null,
				createdAt,
			)
		}
	}

	findDeliveryEventByProviderEventId(
		providerEventId: string,
	): MailboxDeliveryEventRecord | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_delivery_events
				WHERE provider_event_id = ?
				LIMIT 1`,
				providerEventId,
			)
			.toArray()[0]
		return row ? mapMailboxDeliveryEventRow(row) : null
	}

	writeDeliveryEventRow(event: MailboxDeliveryEventInput): boolean {
		const id = assertMailboxNonEmptyString(event.id, 'event.id')
		const eventType = assertMailboxDeliveryEventType(event.eventType)
		const providerEventId = event.providerEventId ?? null
		if (providerEventId) {
			const existingByProvider =
				this.findDeliveryEventByProviderEventId(providerEventId)
			if (existingByProvider && existingByProvider.id !== id) {
				return false
			}
		}
		const existed = this.sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM email_delivery_events WHERE id = ? LIMIT 1`,
				id,
			)
			.toArray()[0]
		const createdAt = assertMailboxCanonicalIsoTimestamp(
			event.createdAt?.trim() || mailboxNowIso(),
			'event.createdAt',
		)
		const detailJson =
			typeof event.detailJson === 'string' && event.detailJson.length > 0
				? event.detailJson
				: '{}'
		const needsEffectReconcile = event.needsEffectReconcile === true ? 1 : 0
		const state =
			event.state == null
				? null
				: assertMailboxInboundDeliveryState(event.state)
		const subscriptionEffectState =
			event.subscriptionEffectState == null
				? null
				: assertMailboxSubscriptionEffectState(event.subscriptionEffectState)

		this.sql.exec(
			`INSERT INTO email_delivery_events (
				id, message_id, inbox_id, event_type, provider,
				provider_message_id, provider_event_id, detail_json,
				needs_effect_reconcile, state, fingerprint,
				storage_lease, storage_lease_at, cleanup_lease, cleanup_lease_at,
				cleanup_retry_at, expected_attachment_count, finalization_token,
				reconcile_after, dedupe_expires_at,
				usage_effect_recorded_at, usage_effect_suppressed_at, usage_started_at,
				usage_month, usage_bytes, usage_duration_ms,
				usage_effect_retry_at, usage_effect_lease, usage_effect_lease_at,
				subscription_effect_state, subscription_effect_lease,
				subscription_effect_lease_at, subscription_effect_retry_at,
				subscription_effect_attempt_count, subscription_effect_dead_letter_at,
				subscription_effect_last_error, created_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT(id) DO UPDATE SET
				message_id = excluded.message_id,
				inbox_id = excluded.inbox_id,
				event_type = excluded.event_type,
				provider = excluded.provider,
				provider_message_id = excluded.provider_message_id,
				provider_event_id = excluded.provider_event_id,
				detail_json = excluded.detail_json,
				needs_effect_reconcile = excluded.needs_effect_reconcile,
				state = excluded.state,
				fingerprint = excluded.fingerprint,
				storage_lease = excluded.storage_lease,
				storage_lease_at = excluded.storage_lease_at,
				cleanup_lease = excluded.cleanup_lease,
				cleanup_lease_at = excluded.cleanup_lease_at,
				cleanup_retry_at = excluded.cleanup_retry_at,
				expected_attachment_count = excluded.expected_attachment_count,
				finalization_token = excluded.finalization_token,
				reconcile_after = excluded.reconcile_after,
				dedupe_expires_at = excluded.dedupe_expires_at,
				usage_effect_recorded_at = excluded.usage_effect_recorded_at,
				usage_effect_suppressed_at = excluded.usage_effect_suppressed_at,
				usage_started_at = excluded.usage_started_at,
				usage_month = excluded.usage_month,
				usage_bytes = excluded.usage_bytes,
				usage_duration_ms = excluded.usage_duration_ms,
				usage_effect_retry_at = excluded.usage_effect_retry_at,
				usage_effect_lease = excluded.usage_effect_lease,
				usage_effect_lease_at = excluded.usage_effect_lease_at,
				subscription_effect_state = excluded.subscription_effect_state,
				subscription_effect_lease = excluded.subscription_effect_lease,
				subscription_effect_lease_at = excluded.subscription_effect_lease_at,
				subscription_effect_retry_at = excluded.subscription_effect_retry_at,
				subscription_effect_attempt_count = excluded.subscription_effect_attempt_count,
				subscription_effect_dead_letter_at = excluded.subscription_effect_dead_letter_at,
				subscription_effect_last_error = excluded.subscription_effect_last_error`,
			id,
			event.messageId ?? null,
			event.inboxId ?? null,
			eventType,
			event.provider ?? 'kody',
			event.providerMessageId ?? null,
			providerEventId,
			detailJson,
			needsEffectReconcile,
			state,
			event.fingerprint ?? null,
			event.storageLease ?? null,
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.storageLeaseAt,
				'event.storageLeaseAt',
			),
			event.cleanupLease ?? null,
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.cleanupLeaseAt,
				'event.cleanupLeaseAt',
			),
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.cleanupRetryAt,
				'event.cleanupRetryAt',
			),
			event.expectedAttachmentCount ?? null,
			event.finalizationToken ?? null,
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.reconcileAfter,
				'event.reconcileAfter',
			),
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.dedupeExpiresAt,
				'event.dedupeExpiresAt',
			),
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.usageEffectRecordedAt,
				'event.usageEffectRecordedAt',
			),
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.usageEffectSuppressedAt,
				'event.usageEffectSuppressedAt',
			),
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.usageStartedAt,
				'event.usageStartedAt',
			),
			event.usageMonth ?? null,
			event.usageBytes ?? null,
			event.usageDurationMs ?? null,
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.usageEffectRetryAt,
				'event.usageEffectRetryAt',
			),
			event.usageEffectLease ?? null,
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.usageEffectLeaseAt,
				'event.usageEffectLeaseAt',
			),
			subscriptionEffectState,
			event.subscriptionEffectLease ?? null,
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.subscriptionEffectLeaseAt,
				'event.subscriptionEffectLeaseAt',
			),
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.subscriptionEffectRetryAt,
				'event.subscriptionEffectRetryAt',
			),
			event.subscriptionEffectAttemptCount ?? null,
			assertOptionalMailboxCanonicalIsoTimestamp(
				event.subscriptionEffectDeadLetterAt,
				'event.subscriptionEffectDeadLetterAt',
			),
			event.subscriptionEffectLastError ?? null,
			createdAt,
		)
		return existed == null
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
		return (
			this.sql
				.exec<{ ok: number }>(
					`SELECT 1 AS ok FROM email_delivery_events
					WHERE id = ? AND message_id = ?
					LIMIT 1`,
					eventId,
					messageId,
				)
				.toArray()[0] != null
		)
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
		const clauses: Array<string> = ['1 = 1']
		const params: Array<SqlStorageValue> = []
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
		if (input.cursor) {
			const cursor = decodeMailboxListCursor(input.cursor)
			clauses.push('(created_at, id) < (?, ?)')
			params.push(cursor.createdAt, cursor.id)
		}
		params.push(limit + 1)
		const rows = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ?`,
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
		const pattern = `%${escapeLikePattern(input.query.trim().toLowerCase())}%`
		const clauses: Array<string> = [
			`(
				LOWER(subject) LIKE ? ESCAPE '\\'
				OR LOWER(from_address) LIKE ? ESCAPE '\\'
				OR LOWER(COALESCE(envelope_from, '')) LIKE ? ESCAPE '\\'
			)`,
		]
		const params: Array<SqlStorageValue> = [pattern, pattern, pattern]
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
		params.push(limit)
		const rows = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_messages
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ?`,
				...params,
			)
			.toArray()
		return { messages: rows.map(mapMailboxMessageRow) }
	}

	listAttachmentsForMessage(messageId: string): Array<MailboxAttachmentRecord> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_attachments
				WHERE message_id = ?
				ORDER BY id ASC`,
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
		const limit = normalizeMailboxPageSize(input.limit)
		const clauses: Array<string> = ['1 = 1']
		const params: Array<SqlStorageValue> = []
		if (input.messageId) {
			clauses.push('message_id = ?')
			params.push(input.messageId)
		}
		if (input.eventType) {
			clauses.push('event_type = ?')
			params.push(assertMailboxDeliveryEventType(input.eventType))
		}
		params.push(limit)
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM email_delivery_events
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ?`,
				...params,
			)
			.toArray()
			.map(mapMailboxDeliveryEventRow)
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
		return listMailboxBlobReferences(this.sql, input)
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
		const row = this.sql
			.exec<{ created_at: string }>(
				`SELECT created_at FROM email_delivery_events
				ORDER BY created_at ASC, id ASC
				LIMIT 1`,
			)
			.toArray()[0]
		return row?.created_at ?? null
	}

	listExpiredMessagesForRetention(input: {
		cutoff: string
		limit: number
	}): Array<{ id: string; raw_mime_key: string | null; created_at: string }> {
		return this.sql
			.exec<{
				id: string
				raw_mime_key: string | null
				created_at: string
			}>(
				`SELECT id, raw_mime_key, created_at FROM email_messages
				WHERE created_at < ?
				ORDER BY created_at ASC, id ASC
				LIMIT ?`,
				input.cutoff,
				input.limit,
			)
			.toArray()
	}

	listAttachmentStorageKeysForMessages(
		messageIds: Array<string>,
	): Array<{ message_id: string; storage_key: string }> {
		if (messageIds.length === 0) return []
		return this.sql
			.exec<{ message_id: string; storage_key: string }>(
				`SELECT message_id, storage_key FROM email_attachments
				WHERE storage_key IS NOT NULL
					AND message_id IN (${messageIds.map(() => '?').join(', ')})`,
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
		this.sql.exec(
			`DELETE FROM email_delivery_events
			WHERE id IN (
				SELECT id FROM email_delivery_events
				WHERE created_at < ?
				ORDER BY created_at ASC, id ASC
				LIMIT ?
			)`,
			input.cutoff,
			input.limit,
		)
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
