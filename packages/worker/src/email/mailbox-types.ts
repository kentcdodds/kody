import {
	emailClassificationValues,
	emailDeliveryEventTypeValues,
	emailDeliveryStatusValues,
	emailDirectionValues,
	emailProcessingStatusValues,
	type EmailClassification,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailProcessingStatus,
} from './types.ts'
import { type MailboxInboundDeliveryLedgerRpc } from './mailbox-inbound-ledger.ts'
import { type MailboxInboundEffectLedgerRpc } from './mailbox-inbound-effect-ledger.ts'

/**
 * Mailbox Durable Object wire types, constants, and boundary validators.
 * Object identity is ownership — records have no `user_id`.
 */

export const mailboxMessageRetentionDays = 365
export const mailboxDeliveryEventRetentionDays = 90
export const mailboxDefaultPageSize = 100
export const mailboxMaxPageSize = 500
/** Max complete delivery-event snapshots per `upsertDeliveryEvents` RPC. */
export const mailboxUpsertDeliveryEventsMax = 100
export const mailboxRetentionBatchSize = 100
export const mailboxRetentionAlarmSkewMs = 60_000
/** Bound retry delay when overdue retention work cannot finish (e.g. R2 errors). */
export const mailboxRetentionRetryDelayMs = 60 * 60 * 1000
/** Near-immediate continuation when a retention pass succeeds but expired rows remain. */
export const mailboxRetentionContinuationDelayMs = 1_000
export const mailboxBlobDeleteMaxKeys = 1000

/**
 * Bump when initializeSchema's DDL set changes. Warm objects run additive
 * migrations (CREATE INDEX IF NOT EXISTS / guarded ALTER) until they match.
 */
export const mailboxSchemaVersion = 2
export const mailboxMetaSchemaVersionKey = 'schema_version'

export const mailboxExportThreadCursorPrefix = 'thread:'
export const mailboxExportMessageCursorPrefix = 'message:'
export const mailboxExportAttachmentCursorPrefix = 'attachment:'
export const mailboxExportDeliveryEventCursorPrefix = 'delivery_event:'

export const mailboxBlobRefRawMimeCursorPrefix = 'raw_mime:'
export const mailboxBlobRefAttachmentCursorPrefix = 'attachment:'

export const mailboxStorageKindValues = [
	'raw-mime',
	'external',
	'unavailable',
] as const
export type MailboxStorageKind = (typeof mailboxStorageKindValues)[number]

export const mailboxInboundDeliveryStateValues = [
	'pending',
	'storing',
	'cleaning',
	'received',
	'rejected',
	'orphan-cleaned',
] as const
export type MailboxInboundDeliveryState =
	(typeof mailboxInboundDeliveryStateValues)[number]

export const mailboxSubscriptionEffectStateValues = [
	'pending',
	'processing',
	'complete',
	'dead-letter',
] as const
export type MailboxSubscriptionEffectState =
	(typeof mailboxSubscriptionEffectStateValues)[number]

/** Canonical UTC ISO-8601 with milliseconds — lexical order matches time order. */
export const mailboxCanonicalIsoTimestampPattern =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type MailboxThreadRecord = {
	id: string
	inboxId: string | null
	subjectNormalized: string | null
	rootMessageIdHeader: string | null
	lastMessageAt: string
	createdAt: string
	updatedAt: string
}

export type MailboxMessageRecord = {
	id: string
	direction: EmailDirection
	inboxId: string | null
	threadId: string | null
	senderIdentityId: string | null
	fromAddress: string | null
	envelopeFrom: string | null
	toAddresses: Array<unknown>
	ccAddresses: Array<unknown>
	bccAddresses: Array<unknown>
	replyToAddresses: Array<unknown>
	subject: string | null
	messageIdHeader: string | null
	inReplyToHeader: string | null
	references: Array<unknown>
	headers: Record<string, unknown> | null
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMimeKey: string | null
	rawSize: number | null
	processingStatus: EmailProcessingStatus
	classification: EmailClassification
	classificationReason: string | null
	providerMessageId: string | null
	deliveryStatus: EmailDeliveryStatus | null
	deliveryStatusAt: string | null
	error: string | null
	receivedAt: string | null
	sentAt: string | null
	createdAt: string
	updatedAt: string
}

export type MailboxAttachmentRecord = {
	id: string
	messageId: string
	filename: string | null
	contentType: string | null
	contentId: string | null
	disposition: string | null
	size: number
	storageKind: MailboxStorageKind
	storageKey: string | null
	createdAt: string
}

/**
 * Delivery-event row including promoted inbound idempotency / effect columns.
 * `detailJson` remains for compatibility with fields not yet promoted.
 */
export type MailboxDeliveryEventRecord = {
	id: string
	messageId: string | null
	inboxId: string | null
	eventType: EmailDeliveryEventType
	provider: string | null
	providerMessageId: string | null
	providerEventId: string | null
	detailJson: string
	needsEffectReconcile: boolean
	state: MailboxInboundDeliveryState | null
	fingerprint: string | null
	storageLease: string | null
	storageLeaseAt: string | null
	cleanupLease: string | null
	cleanupLeaseAt: string | null
	cleanupRetryAt: string | null
	expectedAttachmentCount: number | null
	finalizationToken: string | null
	reconcileAfter: string | null
	dedupeExpiresAt: string | null
	usageEffectRecordedAt: string | null
	usageEffectSuppressedAt: string | null
	usageStartedAt: string | null
	usageMonth: string | null
	usageBytes: number | null
	usageDurationMs: number | null
	usageEffectRetryAt: string | null
	usageEffectLease: string | null
	usageEffectLeaseAt: string | null
	subscriptionEffectState: MailboxSubscriptionEffectState | null
	subscriptionEffectLease: string | null
	subscriptionEffectLeaseAt: string | null
	subscriptionEffectRetryAt: string | null
	subscriptionEffectAttemptCount: number | null
	subscriptionEffectDeadLetterAt: string | null
	subscriptionEffectLastError: string | null
	createdAt: string
	updatedAt: string
}

/**
 * Full thread snapshot for mirror writes — every persisted field is required.
 * Nullable columns use `T | null` (no omitted/defaulted fields).
 */
export type MailboxThreadInput = {
	id: string
	inboxId: string | null
	subjectNormalized: string
	rootMessageIdHeader: string | null
	lastMessageAt: string
	createdAt: string
	/** Stale-snapshot rejection: equal/newer only. */
	updatedAt: string
}

/**
 * Full message snapshot for mirror writes — every persisted field is required.
 * Nullable columns use `T | null` (no omitted/defaulted fields).
 */
export type MailboxMessageInput = {
	id: string
	direction: EmailDirection
	inboxId: string | null
	threadId: string | null
	senderIdentityId: string | null
	fromAddress: string
	envelopeFrom: string | null
	toAddresses: Array<unknown>
	ccAddresses: Array<unknown>
	bccAddresses: Array<unknown>
	replyToAddresses: Array<unknown>
	subject: string
	messageIdHeader: string | null
	inReplyToHeader: string | null
	references: Array<unknown>
	headers: Record<string, unknown>
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMimeKey: string | null
	rawSize: number
	processingStatus: EmailProcessingStatus
	classification: EmailClassification
	classificationReason: string | null
	providerMessageId: string | null
	deliveryStatus: EmailDeliveryStatus | null
	deliveryStatusAt: string | null
	error: string | null
	receivedAt: string | null
	sentAt: string | null
	createdAt: string
	/** Stale-snapshot rejection: equal/newer only. */
	updatedAt: string
}

/**
 * Full attachment snapshot — every persisted field is required.
 * The RPC `attachments` array itself may still be omitted (preserve) or `[]` (clear).
 */
export type MailboxAttachmentInput = {
	id: string
	messageId: string
	filename: string | null
	contentType: string
	contentId: string | null
	disposition: string | null
	size: number
	storageKind: MailboxStorageKind
	storageKey: string | null
	createdAt: string
}

/**
 * Full delivery-event snapshot — every persisted field is required.
 * `updatedAt` is the monotonic mirror timestamp (equal/newer accepted).
 */
export type MailboxDeliveryEventInput = {
	id: string
	messageId: string | null
	inboxId: string | null
	eventType: EmailDeliveryEventType
	provider: string
	providerMessageId: string | null
	providerEventId: string | null
	detailJson: string
	needsEffectReconcile: boolean
	state: MailboxInboundDeliveryState | null
	fingerprint: string | null
	storageLease: string | null
	storageLeaseAt: string | null
	cleanupLease: string | null
	cleanupLeaseAt: string | null
	cleanupRetryAt: string | null
	expectedAttachmentCount: number | null
	finalizationToken: string | null
	reconcileAfter: string | null
	dedupeExpiresAt: string | null
	usageEffectRecordedAt: string | null
	usageEffectSuppressedAt: string | null
	usageStartedAt: string | null
	usageMonth: string | null
	usageBytes: number | null
	usageDurationMs: number | null
	usageEffectRetryAt: string | null
	usageEffectLease: string | null
	usageEffectLeaseAt: string | null
	subscriptionEffectState: MailboxSubscriptionEffectState | null
	subscriptionEffectLease: string | null
	subscriptionEffectLeaseAt: string | null
	subscriptionEffectRetryAt: string | null
	subscriptionEffectAttemptCount: number | null
	subscriptionEffectDeadLetterAt: string | null
	subscriptionEffectLastError: string | null
	createdAt: string
	updatedAt: string
}

export type MailboxExportRow =
	| { kind: 'thread'; row: MailboxThreadRecord }
	| { kind: 'message'; row: MailboxMessageRecord }
	| { kind: 'attachment'; row: MailboxAttachmentRecord }
	| { kind: 'delivery_event'; row: MailboxDeliveryEventRecord }

export type MailboxExportResult = {
	rows: Array<MailboxExportRow>
	nextStartAfter: string | null
	truncated: boolean
}

export type MailboxBlobReference = {
	kind: 'raw_mime' | 'attachment'
	key: string
	messageId: string
	attachmentId: string | null
}

export type MailboxBlobReferencePage = {
	references: Array<MailboxBlobReference>
	nextStartAfter: string | null
	truncated: boolean
}

export type MailboxCountResult = {
	threads: number
	messages: number
	attachments: number
	deliveryEvents: number
}

/**
 * Aggregate result from {@link MailboxRpc.runRetentionNow} (and the shared
 * private retention pass used by `alarm`). Counts only — no row ids or content.
 */
export type MailboxRunRetentionNowResult = {
	before: MailboxCountResult
	after: MailboxCountResult
	blobDeleteFailures: boolean
	expiredRemaining: boolean
}

export type MailboxListMessagesInput = {
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	limit?: number
	/** Keyset cursor; when set, `offset` is ignored. */
	cursor?: string | null
	/** Offset page (account inbox). Ignored when `cursor` is set. */
	offset?: number | null
}

export type MailboxSearchMessagesInput = {
	query: string
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	limit?: number
	offset?: number | null
}

export type MailboxCountMessagesInput = {
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	/** When set, applies the same subject/from/envelope substring match as search. */
	query?: string | null
}

export type MailboxListCursorPayload = {
	createdAt: string
	id: string
}

export type MailboxExportPhase =
	| 'thread'
	| 'message'
	| 'attachment'
	| 'delivery_event'

/** Partial thread touch — equal/newer `updatedAt` only; never regresses `lastMessageAt`. */
export type MailboxTouchThreadInput = {
	ownerId: string
	threadId: string
	lastMessageAt: string
	updatedAt: string
}

/** Partial delivery/processing update — equal/newer `updatedAt` only. */
export type MailboxUpdateMessageDeliveryInput = {
	ownerId: string
	messageId: string
	processingStatus: EmailProcessingStatus
	providerMessageId: string | null
	error: string | null
	sentAt: string | null
	updatedAt: string
}

/** Partial classification update — equal/newer `updatedAt` only. */
export type MailboxSetMessageClassificationInput = {
	ownerId: string
	messageId: string
	classification: EmailClassification
	classificationReason: string | null
	updatedAt: string
}

/**
 * Metadata-only message delete. Never touches R2. Nulls matching delivery
 * event `message_id` first; does not delete empty threads (use
 * `deleteThreadIfEmpty`). Stale when `updated_at` is newer than `deletedAt`.
 */
export type MailboxDeleteMessageMetadataInput = {
	ownerId: string
	messageId: string
	deletedAt: string
}

/**
 * Metadata-only delivery-event delete. Stale when the row's `updated_at` is
 * newer than `deletedAt`. Idempotent when already absent.
 */
export type MailboxDeleteDeliveryEventInput = {
	ownerId: string
	eventId: string
	deletedAt: string
}

/**
 * Deferred empty-thread cleanup (D1 `deleteEmptyEmailThreads` parity).
 * Stale-safe by `thread.updated_at`; no-op when messages remain.
 */
export type MailboxDeleteThreadIfEmptyInput = {
	ownerId: string
	threadId: string
	deletedAt: string
}

/**
 * Partial touch/update/classify outcome.
 * - `accepted` — mutation applied
 * - `missing` — target row absent (idempotent success for best-effort callers)
 * - `stale` — newer `updated_at` retained
 */
export type MailboxPartialMutationResult =
	| { status: 'accepted' }
	| { status: 'missing' }
	| { status: 'stale' }

/**
 * Metadata delete outcome (message, delivery event, or empty thread).
 * - `deleted` — row removed
 * - `missing` — already absent or nothing to delete (idempotent success)
 * - `stale` — newer `updated_at` retained
 */
export type MailboxDeleteResult =
	| { status: 'deleted' }
	| { status: 'missing' }
	| { status: 'stale' }

/** Per-event outcome from {@link MailboxRpc.upsertDeliveryEvents}. */
export type MailboxUpsertDeliveryEventBatchItemResult = {
	eventId: string
	inserted: boolean
	accepted: boolean
}

export type MailboxUpsertDeliveryEventsResult = {
	results: Array<MailboxUpsertDeliveryEventBatchItemResult>
}

/**
 * Mirror / read / retention / purge surface. Inbound ledger CAS RPCs
 * (additive step 2a) are intersected below — not live-wired; D1 remains
 * authority.
 */
type MailboxCoreRpc = {
	mirrorMessage: (input: {
		/**
		 * Explicit owner binding. DO name is not introspectable at runtime, so
		 * writers must pass the owning user id for blob-key validation and
		 * singleton identity checks.
		 */
		ownerId: string
		thread?: MailboxThreadInput | null
		message: MailboxMessageInput
		/**
		 * Omitted → leave existing attachment metadata unchanged.
		 * Explicit `[]` → clear attachments (only when the message snapshot is accepted).
		 */
		attachments?: Array<MailboxAttachmentInput>
	}) => Promise<{ ok: true; accepted: boolean }>
	/**
	 * Compatibility mirror upsert for complete delivery-event snapshots.
	 * Remains available during step 2a; CAS ledger RPCs are additive.
	 */
	upsertDeliveryEvent: (input: {
		ownerId: string
		event: MailboxDeliveryEventInput
		latestDeliveryStatus?: {
			messageId: string
			deliveryStatus: EmailDeliveryStatus
			deliveryStatusAt: string
		} | null
	}) => Promise<{
		inserted: boolean
		accepted: boolean
		updatedLatestStatus: boolean
	}>
	/**
	 * Upsert a bounded batch of complete immutable delivery-event snapshots in
	 * one transaction. Does not patch message latest delivery status — that
	 * remains from the prior full message snapshot.
	 */
	upsertDeliveryEvents: (input: {
		ownerId: string
		events: Array<MailboxDeliveryEventInput>
	}) => Promise<MailboxUpsertDeliveryEventsResult>
	touchThread: (
		input: MailboxTouchThreadInput,
	) => Promise<MailboxPartialMutationResult>
	updateMessageDelivery: (
		input: MailboxUpdateMessageDeliveryInput,
	) => Promise<MailboxPartialMutationResult>
	setMessageClassification: (
		input: MailboxSetMessageClassificationInput,
	) => Promise<MailboxPartialMutationResult>
	deleteMessageMetadata: (
		input: MailboxDeleteMessageMetadataInput,
	) => Promise<MailboxDeleteResult>
	deleteDeliveryEvent: (
		input: MailboxDeleteDeliveryEventInput,
	) => Promise<MailboxDeleteResult>
	deleteThreadIfEmpty: (
		input: MailboxDeleteThreadIfEmptyInput,
	) => Promise<MailboxDeleteResult>
	getThread: (input: {
		threadId: string
	}) => Promise<MailboxThreadRecord | null>
	getMessage: (input: {
		messageId: string
	}) => Promise<MailboxMessageRecord | null>
	getMessageByMessageIdHeader: (input: {
		messageIdHeader: string
	}) => Promise<MailboxMessageRecord | null>
	getOutboundMessageByProviderMessageId: (input: {
		providerMessageId: string
	}) => Promise<MailboxMessageRecord | null>
	listMessages: (input: MailboxListMessagesInput) => Promise<{
		messages: Array<MailboxMessageRecord>
		nextCursor: string | null
	}>
	searchMessages: (input: MailboxSearchMessagesInput) => Promise<{
		messages: Array<MailboxMessageRecord>
	}>
	countMessages: (
		input: MailboxCountMessagesInput,
	) => Promise<{ total: number }>
	getAttachment: (input: {
		attachmentId: string
	}) => Promise<MailboxAttachmentRecord | null>
	listAttachmentsForMessage: (input: {
		messageId: string
	}) => Promise<Array<MailboxAttachmentRecord>>
	listDeliveryEvents: (input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	}) => Promise<Array<MailboxDeliveryEventRecord>>
	countMailbox: () => Promise<MailboxCountResult>
	exportMailbox: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<MailboxExportResult>
	listBlobReferences: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<MailboxBlobReferencePage>
	/**
	 * Owner-bound retention pass using natural production cutoffs only (no
	 * cutoff override). Reuses the same pass + alarm reschedule as `alarm`.
	 */
	runRetentionNow: (input: {
		ownerId: string
	}) => Promise<MailboxRunRetentionNowResult>
	purge: () => Promise<{ ok: true }>
}

export type MailboxInboundLedgerRpc = MailboxInboundDeliveryLedgerRpc &
	MailboxInboundEffectLedgerRpc

export type MailboxRpc = MailboxCoreRpc & MailboxInboundLedgerRpc

export function mailboxNowIso() {
	return new Date().toISOString()
}

export function normalizeMailboxPageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: mailboxDefaultPageSize
	return Math.min(Math.max(requested, 1), mailboxMaxPageSize)
}

/** Non-negative offset; invalid/omitted values become 0. */
export function normalizeMailboxOffset(offset: number | null | undefined) {
	if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0
	return Math.max(0, Math.trunc(offset))
}

export function assertMailboxNonEmptyString(
	value: unknown,
	label: string,
): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Mailbox ${label} must be a non-empty string.`)
	}
	return value
}

export function assertMailboxCanonicalIsoTimestamp(
	value: string,
	label: string,
): string {
	if (!mailboxCanonicalIsoTimestampPattern.test(value)) {
		throw new Error(
			`Mailbox ${label} must be a canonical ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).`,
		)
	}
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`Mailbox ${label} is not a valid timestamp.`)
	}
	return value
}

export function assertOptionalMailboxCanonicalIsoTimestamp(
	value: string | null | undefined,
	label: string,
): string | null {
	if (value == null) return null
	return assertMailboxCanonicalIsoTimestamp(value, label)
}

export function assertMailboxDirection(value: string): EmailDirection {
	if (!(emailDirectionValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox direction must be inbound or outbound; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailDirection
}

export function assertMailboxProcessingStatus(
	value: string,
): EmailProcessingStatus {
	if (!(emailProcessingStatusValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox processingStatus is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailProcessingStatus
}

export function assertMailboxClassification(
	value: string,
): EmailClassification {
	if (!(emailClassificationValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox classification is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailClassification
}

export function assertMailboxDeliveryStatus(
	value: string,
): EmailDeliveryStatus {
	if (!(emailDeliveryStatusValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox deliveryStatus is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailDeliveryStatus
}

export function assertMailboxDeliveryEventType(
	value: string,
): EmailDeliveryEventType {
	if (
		!(emailDeliveryEventTypeValues as ReadonlyArray<string>).includes(value)
	) {
		throw new Error(
			`Mailbox eventType is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailDeliveryEventType
}

export function assertMailboxStorageKind(value: string): MailboxStorageKind {
	if (!(mailboxStorageKindValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox storageKind is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as MailboxStorageKind
}

export function assertMailboxInboundDeliveryState(
	value: string,
): MailboxInboundDeliveryState {
	if (
		!(mailboxInboundDeliveryStateValues as ReadonlyArray<string>).includes(
			value,
		)
	) {
		throw new Error(
			`Mailbox delivery event state is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as MailboxInboundDeliveryState
}

export function assertMailboxSubscriptionEffectState(
	value: string,
): MailboxSubscriptionEffectState {
	if (
		!(mailboxSubscriptionEffectStateValues as ReadonlyArray<string>).includes(
			value,
		)
	) {
		throw new Error(
			`Mailbox subscriptionEffectState is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as MailboxSubscriptionEffectState
}

export function encodeMailboxListCursor(payload: MailboxListCursorPayload) {
	return btoa(JSON.stringify(payload))
}

export function decodeMailboxListCursor(
	cursor: string,
): MailboxListCursorPayload {
	let parsed: unknown
	try {
		parsed = JSON.parse(atob(cursor)) as unknown
	} catch {
		throw new Error('Mailbox list cursor is invalid.')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Mailbox list cursor is invalid.')
	}
	const record = parsed as Record<string, unknown>
	const createdAt = record['createdAt']
	const id = record['id']
	if (typeof createdAt !== 'string' || typeof id !== 'string') {
		throw new Error('Mailbox list cursor is invalid.')
	}
	assertMailboxCanonicalIsoTimestamp(createdAt, 'list cursor createdAt')
	assertMailboxNonEmptyString(id, 'list cursor id')
	return { createdAt, id }
}

export function parseMailboxExportCursor(cursor: string | null): {
	phase: MailboxExportPhase
	startAfterId: string
} {
	if (cursor == null || cursor.length === 0) {
		return { phase: 'thread', startAfterId: '' }
	}
	if (cursor.startsWith(mailboxExportThreadCursorPrefix)) {
		return {
			phase: 'thread',
			startAfterId: cursor.slice(mailboxExportThreadCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxExportMessageCursorPrefix)) {
		return {
			phase: 'message',
			startAfterId: cursor.slice(mailboxExportMessageCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxExportAttachmentCursorPrefix)) {
		return {
			phase: 'attachment',
			startAfterId: cursor.slice(mailboxExportAttachmentCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxExportDeliveryEventCursorPrefix)) {
		return {
			phase: 'delivery_event',
			startAfterId: cursor.slice(mailboxExportDeliveryEventCursorPrefix.length),
		}
	}
	throw new Error(
		`Mailbox export cursor is invalid; got ${JSON.stringify(cursor)}.`,
	)
}

export function mailboxExportCursorPrefixForPhase(
	phase: MailboxExportPhase,
): string {
	switch (phase) {
		case 'thread':
			return mailboxExportThreadCursorPrefix
		case 'message':
			return mailboxExportMessageCursorPrefix
		case 'attachment':
			return mailboxExportAttachmentCursorPrefix
		case 'delivery_event':
			return mailboxExportDeliveryEventCursorPrefix
		default: {
			const exhaustive: never = phase
			throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
		}
	}
}

export function parseMailboxBlobRefCursor(cursor: string | null): {
	phase: 'raw_mime' | 'attachment'
	startAfterId: string
} {
	if (cursor == null || cursor.length === 0) {
		return { phase: 'raw_mime', startAfterId: '' }
	}
	if (cursor.startsWith(mailboxBlobRefAttachmentCursorPrefix)) {
		return {
			phase: 'attachment',
			startAfterId: cursor.slice(mailboxBlobRefAttachmentCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxBlobRefRawMimeCursorPrefix)) {
		return {
			phase: 'raw_mime',
			startAfterId: cursor.slice(mailboxBlobRefRawMimeCursorPrefix.length),
		}
	}
	throw new Error(
		`Mailbox blob-reference cursor is invalid; got ${JSON.stringify(cursor)}.`,
	)
}
