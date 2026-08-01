import {
	type EmailAttachmentRecord,
	type EmailDeliveryEventRecord,
	type EmailMessageRecord,
	type EmailThreadRecord,
} from './types.ts'
import {
	assertMailboxClassification,
	assertMailboxDeliveryEventType,
	assertMailboxDeliveryStatus,
	assertMailboxDirection,
	assertMailboxProcessingStatus,
	assertMailboxStorageKind,
	mailboxInboundDeliveryStateValues,
	mailboxSubscriptionEffectStateValues,
	type MailboxAttachmentInput,
	type MailboxDeliveryEventInput,
	type MailboxMessageInput,
	type MailboxThreadInput,
} from './mailbox-types.ts'

/**
 * Pure D1 → Mailbox complete-snapshot converters.
 *
 * Normalize nulls to Mailbox SQLite defaults (empty strings, `[]`, `{}`, `0`,
 * `application/octet-stream`, `kody`). Delivery-event conversion takes an
 * additive {@link EmailDeliveryEventMirrorSnapshot}: D1-promoted columns are
 * authoritative; `detail_json` supplies only fields that remain JSON-owned.
 * Invalid persisted JSON/enums fail clearly rather than fabricating state.
 */

/**
 * Additive delivery-event mirror input. D1 `EmailDeliveryEventRecord` does not
 * yet expose promoted columns or `updated_at`; callers pass those explicitly.
 *
 * Authoritative D1 columns (do not read these from `detail_json`):
 * - `needs_effect_reconcile`
 * - `usage_effect_recorded_at`
 * - `usage_month`
 * - `usage_bytes`
 * - `usage_duration_ms`
 *
 * Still JSON-owned in `detail_json` (inbound/effect lease fields, etc.).
 */
export type EmailDeliveryEventMirrorSnapshot = {
	event: EmailDeliveryEventRecord
	/** D1 delivery events lack `updated_at`; required for stale rejection. */
	updatedAt: string
	/** D1 `needs_effect_reconcile` column. */
	needsEffectReconcile: boolean
	/** D1 `usage_effect_recorded_at` column. */
	usageEffectRecordedAt: string | null
	/** D1 `usage_month` column. */
	usageMonth: string | null
	/** D1 `usage_bytes` column. */
	usageBytes: number | null
	/** D1 `usage_duration_ms` column. */
	usageDurationMs: number | null
}

function requireOptionalString(value: unknown, label: string): string | null {
	if (value == null) return null
	if (typeof value !== 'string') {
		throw new Error(
			`Mailbox snapshot ${label} must be a string or null; got ${JSON.stringify(value)}.`,
		)
	}
	return value
}

function requireOptionalNumber(value: unknown, label: string): number | null {
	if (value == null) return null
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(
			`Mailbox snapshot ${label} must be a finite number or null; got ${JSON.stringify(value)}.`,
		)
	}
	return value
}

function requireOptionalEnum<T extends string>(
	values: ReadonlyArray<T>,
	value: unknown,
	label: string,
): T | null {
	if (value == null) return null
	if (
		typeof value !== 'string' ||
		!(values as ReadonlyArray<string>).includes(value)
	) {
		throw new Error(
			`Mailbox snapshot ${label} is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as T
}

function parseDetailRecord(detailJson: string): Record<string, unknown> {
	let parsed: unknown
	try {
		parsed = JSON.parse(detailJson) as unknown
	} catch {
		throw new Error(
			`Mailbox snapshot detailJson is not valid JSON; got ${JSON.stringify(detailJson)}.`,
		)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(
			`Mailbox snapshot detailJson must be a JSON object; got ${JSON.stringify(parsed)}.`,
		)
	}
	return parsed as Record<string, unknown>
}

/** Convert a D1 thread row into a full Mailbox thread snapshot. */
export function toMailboxThreadInput(
	thread: EmailThreadRecord,
): MailboxThreadInput {
	return {
		id: thread.id,
		inboxId: thread.inboxId,
		subjectNormalized: thread.subjectNormalized ?? '',
		rootMessageIdHeader: thread.rootMessageIdHeader,
		lastMessageAt: thread.lastMessageAt ?? thread.createdAt,
		createdAt: thread.createdAt,
		updatedAt: thread.updatedAt,
	}
}

/** Convert a D1 message row into a full Mailbox message snapshot. */
export function toMailboxMessageInput(
	message: EmailMessageRecord,
): MailboxMessageInput {
	const deliveryStatus =
		message.deliveryStatus == null
			? null
			: assertMailboxDeliveryStatus(message.deliveryStatus)
	return {
		id: message.id,
		direction: assertMailboxDirection(message.direction),
		inboxId: message.inboxId,
		threadId: message.threadId,
		senderIdentityId: message.senderIdentityId,
		fromAddress: message.fromAddress ?? '',
		envelopeFrom: message.envelopeFrom,
		toAddresses: message.toAddresses ?? [],
		ccAddresses: message.ccAddresses ?? [],
		bccAddresses: message.bccAddresses ?? [],
		replyToAddresses: message.replyToAddresses ?? [],
		subject: message.subject ?? '',
		messageIdHeader: message.messageIdHeader,
		inReplyToHeader: message.inReplyToHeader,
		references: message.references ?? [],
		headers: message.headers ?? {},
		authResults: message.authResults,
		textBody: message.textBody,
		htmlBody: message.htmlBody,
		rawMimeKey: message.rawMimeKey,
		rawSize: message.rawSize ?? 0,
		processingStatus: assertMailboxProcessingStatus(message.processingStatus),
		classification: assertMailboxClassification(message.classification),
		classificationReason: message.classificationReason,
		providerMessageId: message.providerMessageId,
		deliveryStatus,
		deliveryStatusAt: message.deliveryStatusAt,
		error: message.error,
		receivedAt: message.receivedAt,
		sentAt: message.sentAt,
		createdAt: message.createdAt,
		updatedAt: message.updatedAt,
	}
}

/** Convert a D1 attachment row into a full Mailbox attachment snapshot. */
export function toMailboxAttachmentInput(
	attachment: EmailAttachmentRecord,
): MailboxAttachmentInput {
	return {
		id: attachment.id,
		messageId: attachment.messageId,
		filename: attachment.filename,
		contentType: attachment.contentType ?? 'application/octet-stream',
		contentId: attachment.contentId,
		disposition: attachment.disposition,
		size: attachment.size,
		storageKind: assertMailboxStorageKind(attachment.storageKind),
		storageKey: attachment.storageKey,
		createdAt: attachment.createdAt,
	}
}

/**
 * Convert a D1 delivery-event mirror snapshot into a full Mailbox input.
 * Promoted D1 columns win; remaining inbound/effect fields come from JSON.
 */
export function toMailboxDeliveryEventInput(
	snapshot: EmailDeliveryEventMirrorSnapshot,
): MailboxDeliveryEventInput {
	const {
		event,
		updatedAt,
		needsEffectReconcile,
		usageEffectRecordedAt,
		usageMonth,
		usageBytes,
		usageDurationMs,
	} = snapshot
	if (typeof needsEffectReconcile !== 'boolean') {
		throw new Error(
			`Mailbox snapshot needsEffectReconcile must be a boolean; got ${JSON.stringify(needsEffectReconcile)}.`,
		)
	}
	if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
		throw new Error(
			`Mailbox snapshot updatedAt must be a non-empty string; got ${JSON.stringify(updatedAt)}.`,
		)
	}
	if (
		usageEffectRecordedAt != null &&
		typeof usageEffectRecordedAt !== 'string'
	) {
		throw new Error(
			`Mailbox snapshot usageEffectRecordedAt must be a string or null; got ${JSON.stringify(usageEffectRecordedAt)}.`,
		)
	}
	if (usageMonth != null && typeof usageMonth !== 'string') {
		throw new Error(
			`Mailbox snapshot usageMonth must be a string or null; got ${JSON.stringify(usageMonth)}.`,
		)
	}
	if (
		usageBytes != null &&
		(typeof usageBytes !== 'number' || !Number.isFinite(usageBytes))
	) {
		throw new Error(
			`Mailbox snapshot usageBytes must be a finite number or null; got ${JSON.stringify(usageBytes)}.`,
		)
	}
	if (
		usageDurationMs != null &&
		(typeof usageDurationMs !== 'number' || !Number.isFinite(usageDurationMs))
	) {
		throw new Error(
			`Mailbox snapshot usageDurationMs must be a finite number or null; got ${JSON.stringify(usageDurationMs)}.`,
		)
	}

	const detail = parseDetailRecord(event.detailJson)

	return {
		id: event.id,
		messageId: event.messageId,
		inboxId: event.inboxId,
		eventType: assertMailboxDeliveryEventType(event.eventType),
		provider: event.provider ?? 'kody',
		providerMessageId: event.providerMessageId,
		providerEventId: event.providerEventId,
		detailJson: event.detailJson,
		needsEffectReconcile,
		state: requireOptionalEnum(
			mailboxInboundDeliveryStateValues,
			detail['state'],
			'detail.state',
		),
		fingerprint: requireOptionalString(
			detail['fingerprint'],
			'detail.fingerprint',
		),
		storageLease: requireOptionalString(
			detail['storageLease'],
			'detail.storageLease',
		),
		storageLeaseAt: requireOptionalString(
			detail['storageLeaseAt'],
			'detail.storageLeaseAt',
		),
		cleanupLease: requireOptionalString(
			detail['cleanupLease'],
			'detail.cleanupLease',
		),
		cleanupLeaseAt: requireOptionalString(
			detail['cleanupLeaseAt'],
			'detail.cleanupLeaseAt',
		),
		cleanupRetryAt: requireOptionalString(
			detail['cleanupRetryAt'],
			'detail.cleanupRetryAt',
		),
		expectedAttachmentCount: requireOptionalNumber(
			detail['expectedAttachmentCount'],
			'detail.expectedAttachmentCount',
		),
		finalizationToken: requireOptionalString(
			detail['finalizationToken'],
			'detail.finalizationToken',
		),
		reconcileAfter: requireOptionalString(
			detail['reconcileAfter'],
			'detail.reconcileAfter',
		),
		dedupeExpiresAt: requireOptionalString(
			detail['dedupeExpiresAt'],
			'detail.dedupeExpiresAt',
		),
		// Authoritative D1 columns — ignore any JSON copies of these keys.
		usageEffectRecordedAt,
		usageEffectSuppressedAt: requireOptionalString(
			detail['usageEffectSuppressedAt'],
			'detail.usageEffectSuppressedAt',
		),
		usageStartedAt: requireOptionalString(
			detail['usageStartedAt'],
			'detail.usageStartedAt',
		),
		usageMonth,
		usageBytes,
		usageDurationMs,
		usageEffectRetryAt: requireOptionalString(
			detail['usageEffectRetryAt'],
			'detail.usageEffectRetryAt',
		),
		usageEffectLease: requireOptionalString(
			detail['usageEffectLease'],
			'detail.usageEffectLease',
		),
		usageEffectLeaseAt: requireOptionalString(
			detail['usageEffectLeaseAt'],
			'detail.usageEffectLeaseAt',
		),
		subscriptionEffectState: requireOptionalEnum(
			mailboxSubscriptionEffectStateValues,
			detail['subscriptionEffectState'],
			'detail.subscriptionEffectState',
		),
		subscriptionEffectLease: requireOptionalString(
			detail['subscriptionEffectLease'],
			'detail.subscriptionEffectLease',
		),
		subscriptionEffectLeaseAt: requireOptionalString(
			detail['subscriptionEffectLeaseAt'],
			'detail.subscriptionEffectLeaseAt',
		),
		subscriptionEffectRetryAt: requireOptionalString(
			detail['subscriptionEffectRetryAt'],
			'detail.subscriptionEffectRetryAt',
		),
		subscriptionEffectAttemptCount: requireOptionalNumber(
			detail['subscriptionEffectAttemptCount'],
			'detail.subscriptionEffectAttemptCount',
		),
		subscriptionEffectDeadLetterAt: requireOptionalString(
			detail['subscriptionEffectDeadLetterAt'],
			'detail.subscriptionEffectDeadLetterAt',
		),
		subscriptionEffectLastError: requireOptionalString(
			detail['subscriptionEffectLastError'],
			'detail.subscriptionEffectLastError',
		),
		createdAt: event.createdAt,
		updatedAt,
	}
}
