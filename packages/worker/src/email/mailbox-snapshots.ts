import {
	type EmailAttachmentRecord,
	type EmailDeliveryEventType,
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
 * `application/octet-stream`, `kody`). Delivery-event conversion consumes a
 * complete {@link EmailDeliveryEventMirrorProjection} (base + promoted D1
 * columns) plus an explicit `sourceMutationAt`. Invalid persisted JSON/enums
 * fail clearly rather than fabricating state.
 *
 * Load projections via `mailbox-snapshot-repo.ts` — callers must not assemble
 * promoted columns field-by-field.
 */

/**
 * Complete D1 delivery-event mirror projection for D1-authoritative events:
 * base row fields plus promoted compatibility columns.
 *
 * Authoritative D1 columns (never read from `detail_json`):
 * - `needs_effect_reconcile`
 * - `usage_effect_recorded_at`
 * - `usage_month`
 * - `usage_bytes`
 * - `usage_duration_ms`
 */
export type EmailDeliveryEventMirrorProjection = {
	id: string
	messageId: string | null
	userId: string | null
	inboxId: string | null
	eventType: EmailDeliveryEventType
	provider: string | null
	providerMessageId: string | null
	providerEventId: string | null
	detailJson: string
	createdAt: string
	needsEffectReconcile: boolean
	usageEffectRecordedAt: string | null
	usageMonth: string | null
	usageBytes: number | null
	usageDurationMs: number | null
}

function describeSnapshotValue(value: unknown): string {
	if (value === null) return 'null'
	if (value === undefined) return 'undefined'
	if (typeof value === 'string') {
		return `string (${value.length} chars)`
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? 'number' : 'number (non-finite)'
	}
	if (typeof value === 'boolean') return 'boolean'
	if (Array.isArray(value)) return `array (${value.length} items)`
	if (typeof value === 'object') {
		return `object (${Object.keys(value as Record<string, unknown>).length} keys)`
	}
	return typeof value
}

function requireOptionalString(value: unknown, label: string): string | null {
	if (value == null) return null
	if (typeof value !== 'string') {
		throw new Error(
			`Mailbox snapshot ${label} must be a string or null; got ${describeSnapshotValue(value)}.`,
		)
	}
	return value
}

function requireOptionalNumber(value: unknown, label: string): number | null {
	if (value == null) return null
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(
			`Mailbox snapshot ${label} must be a finite number or null; got ${describeSnapshotValue(value)}.`,
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
			`Mailbox snapshot ${label} is invalid; got ${describeSnapshotValue(value)}.`,
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
			`Mailbox snapshot detailJson is not valid JSON; payload is ${detailJson.length} bytes.`,
		)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(
			`Mailbox snapshot detailJson must be a JSON object; got ${describeSnapshotValue(parsed)}.`,
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
 * Convert a complete D1 delivery-event projection into a Mailbox input.
 * Promoted columns win; remaining inbound/effect fields come from JSON.
 *
 * `sourceMutationAt` becomes Mailbox `updatedAt`; inserts use `created_at`.
 */
export function toMailboxDeliveryEventInput(input: {
	projection: EmailDeliveryEventMirrorProjection
	sourceMutationAt: string
}): MailboxDeliveryEventInput {
	const { projection, sourceMutationAt } = input
	if (typeof sourceMutationAt !== 'string' || sourceMutationAt.length === 0) {
		throw new Error(
			`Mailbox snapshot sourceMutationAt must be a non-empty string; got ${JSON.stringify(sourceMutationAt)}.`,
		)
	}
	if (typeof projection.needsEffectReconcile !== 'boolean') {
		throw new Error(
			`Mailbox snapshot needsEffectReconcile must be a boolean; got ${JSON.stringify(projection.needsEffectReconcile)}.`,
		)
	}

	const detail = parseDetailRecord(projection.detailJson)

	return {
		id: projection.id,
		messageId: projection.messageId,
		inboxId: projection.inboxId,
		eventType: assertMailboxDeliveryEventType(projection.eventType),
		provider: projection.provider ?? 'kody',
		providerMessageId: projection.providerMessageId,
		providerEventId: projection.providerEventId,
		detailJson: projection.detailJson,
		needsEffectReconcile: projection.needsEffectReconcile,
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
		usageEffectRecordedAt: projection.usageEffectRecordedAt,
		usageEffectSuppressedAt: requireOptionalString(
			detail['usageEffectSuppressedAt'],
			'detail.usageEffectSuppressedAt',
		),
		usageStartedAt: requireOptionalString(
			detail['usageStartedAt'],
			'detail.usageStartedAt',
		),
		usageMonth: projection.usageMonth,
		usageBytes: requireOptionalNumber(projection.usageBytes, 'usageBytes'),
		usageDurationMs: requireOptionalNumber(
			projection.usageDurationMs,
			'usageDurationMs',
		),
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
		createdAt: projection.createdAt,
		updatedAt: sourceMutationAt,
	}
}
