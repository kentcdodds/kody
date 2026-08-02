import {
	mailboxInboundDedupePointerId,
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
} from './mailbox-inbound-ledger.ts'
import {
	parseInboundDeliveryDetailJson,
	parseStrictInboundDeliveryDetailJson,
} from './inbound-delivery.ts'
import { mapMailboxDeliveryEventRow } from './mailbox-mappers.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
} from './mailbox-types.ts'

const preClaimAuditPhases = new Set([
	'entitlement',
	'size',
	'account-verification',
	'account-suspension',
	'sender-policy',
	'system-limit',
])
const auditDayPattern = /^\d{4}-\d{2}-\d{2}$/

function isCanonicalTimestamp(value: string) {
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isUserInboundAuthorityEvent(event: MailboxDeliveryEventInput) {
	return (
		event.provider === mailboxInboundProvider ||
		event.provider === mailboxInboundDedupeProvider
	)
}

function hasNoInboundAuthorityState(
	event: MailboxDeliveryEventInput | MailboxDeliveryEventRecord,
) {
	return (
		event.messageId == null &&
		event.providerMessageId == null &&
		event.providerEventId == null &&
		event.state == null &&
		event.fingerprint == null &&
		event.storageLease == null &&
		event.storageLeaseAt == null &&
		event.cleanupLease == null &&
		event.cleanupLeaseAt == null &&
		event.cleanupRetryAt == null &&
		event.expectedAttachmentCount == null &&
		event.finalizationToken == null &&
		event.reconcileAfter == null &&
		event.dedupeExpiresAt == null &&
		event.usageEffectRecordedAt == null &&
		event.usageEffectSuppressedAt == null &&
		event.usageStartedAt == null &&
		event.usageMonth == null &&
		event.usageBytes == null &&
		event.usageDurationMs == null &&
		event.usageEffectRetryAt == null &&
		event.usageEffectLease == null &&
		event.usageEffectLeaseAt == null &&
		event.subscriptionEffectState == null &&
		event.subscriptionEffectLease == null &&
		event.subscriptionEffectLeaseAt == null &&
		event.subscriptionEffectRetryAt == null &&
		event.subscriptionEffectAttemptCount == null &&
		event.subscriptionEffectDeadLetterAt == null &&
		event.subscriptionEffectLastError == null
	)
}

export function isPreClaimAuditSnapshot(
	event: MailboxDeliveryEventInput | MailboxDeliveryEventRecord,
) {
	if (
		event.provider !== mailboxInboundProvider ||
		event.eventType !== 'rejected' ||
		typeof event.inboxId !== 'string' ||
		event.inboxId.length === 0 ||
		!hasNoInboundAuthorityState(event)
	) {
		return false
	}
	let detail: unknown
	try {
		detail = JSON.parse(event.detailJson)
	} catch {
		return false
	}
	if (
		typeof detail !== 'object' ||
		detail == null ||
		!('aggregate' in detail) ||
		detail.aggregate !== true ||
		!('day' in detail) ||
		typeof detail.day !== 'string' ||
		!auditDayPattern.test(detail.day) ||
		!('count' in detail) ||
		typeof detail.count !== 'number' ||
		!Number.isInteger(detail.count) ||
		detail.count < 1 ||
		!('last_reason' in detail) ||
		typeof detail.last_reason !== 'string' ||
		!('last_phase' in detail) ||
		typeof detail.last_phase !== 'string' ||
		!preClaimAuditPhases.has(detail.last_phase) ||
		!('last_at' in detail) ||
		typeof detail.last_at !== 'string' ||
		!isCanonicalTimestamp(detail.last_at)
	) {
		return false
	}
	return event.id === `email-rejections:${event.inboxId}:${detail.day}`
}

export function isUserInboundLegacyAuthoritySnapshot(
	event: MailboxDeliveryEventInput,
) {
	return isUserInboundAuthorityEvent(event) && !isPreClaimAuditSnapshot(event)
}

export function hasMalformedUserInboundBootstrapSchedule(
	event: MailboxDeliveryEventInput,
) {
	if (!isUserInboundLegacyAuthoritySnapshot(event)) return false
	if (!parseInboundDeliveryDetailJson(event.detailJson)) return false
	try {
		const detail = JSON.parse(event.detailJson) as Record<string, unknown>
		return ['cleanupRetryAt', 'reconcileAfter'].some((field) => {
			if (!(field in detail)) return false
			const value = detail[field]
			return (
				typeof value !== 'string' ||
				!Number.isFinite(Date.parse(value)) ||
				new Date(value).toISOString() !== value
			)
		})
	} catch {
		return false
	}
}

function readMailboxDeliveryEvent(
	sql: SqlStorage,
	eventId: string,
): MailboxDeliveryEventRecord | null {
	const row = sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events WHERE id = ? LIMIT 1`,
			eventId,
		)
		.toArray()[0]
	return row ? mapMailboxDeliveryEventRow(row) : null
}

/**
 * Validate the only D1 → Mailbox USER inbound bridge. Callers may insert this
 * snapshot only when its owner-bound row is missing.
 */
export function assertUserInboundLegacyBootstrapSnapshot(input: {
	ownerId: string
	event: MailboxDeliveryEventInput
}) {
	if (!isUserInboundLegacyAuthoritySnapshot(input.event)) {
		throw new Error(
			'USER inbound bootstrap requires an inbound lifecycle or dedupe snapshot.',
		)
	}
	const delivery = parseStrictInboundDeliveryDetailJson(input.event.detailJson)
	const expectedEventId =
		input.event.provider === mailboxInboundDedupeProvider && delivery
			? mailboxInboundDedupePointerId(delivery.fingerprint)
			: delivery?.deliveryId
	const expectedEventType =
		delivery?.state === 'received'
			? 'received'
			: delivery?.state === 'rejected'
				? 'rejected'
				: 'receive_started'
	const optionalMatches = (actual: unknown, expected: unknown) =>
		actual === (expected ?? null)
	const lifecycle = input.event.provider === mailboxInboundProvider
	const expectedCleanupRetryAt =
		lifecycle && delivery?.state === 'orphan-cleaned'
			? delivery.cleanupRetryAt
			: null
	const expectedReconcileAfter =
		lifecycle &&
		(delivery?.state === 'pending' ||
			delivery?.state === 'storing' ||
			delivery?.state === 'cleaning' ||
			delivery?.state === 'orphan-cleaned')
			? delivery.reconcileAfter
			: null
	if (
		!delivery ||
		delivery.userId !== input.ownerId ||
		delivery.provider !== mailboxInboundProvider ||
		input.event.id !== expectedEventId ||
		input.event.inboxId !== delivery.inboxId ||
		input.event.eventType !== expectedEventType ||
		input.event.providerMessageId != null ||
		input.event.providerEventId !== input.event.id ||
		input.event.messageId !==
			(delivery.state === 'received' ? delivery.messageId : null) ||
		input.event.state !== delivery.state ||
		input.event.fingerprint !== delivery.fingerprint ||
		!optionalMatches(input.event.storageLease, delivery.storageLease) ||
		!optionalMatches(input.event.storageLeaseAt, delivery.storageLeaseAt) ||
		!optionalMatches(input.event.cleanupLease, delivery.cleanupLease) ||
		!optionalMatches(input.event.cleanupLeaseAt, delivery.cleanupLeaseAt) ||
		!optionalMatches(input.event.cleanupRetryAt, expectedCleanupRetryAt) ||
		!optionalMatches(
			input.event.expectedAttachmentCount,
			delivery.expectedAttachmentCount,
		) ||
		!optionalMatches(
			input.event.finalizationToken,
			delivery.finalizationToken,
		) ||
		!optionalMatches(input.event.reconcileAfter, expectedReconcileAfter) ||
		!optionalMatches(input.event.dedupeExpiresAt, delivery.dedupeExpiresAt) ||
		!optionalMatches(
			input.event.usageEffectRecordedAt,
			delivery.usageEffectRecordedAt,
		) ||
		!optionalMatches(
			input.event.usageEffectSuppressedAt,
			delivery.usageEffectSuppressedAt,
		) ||
		!optionalMatches(input.event.usageStartedAt, delivery.usageStartedAt) ||
		!optionalMatches(input.event.usageMonth, delivery.usageMonth) ||
		!optionalMatches(input.event.usageBytes, delivery.usageBytes) ||
		!optionalMatches(input.event.usageDurationMs, delivery.usageDurationMs) ||
		!optionalMatches(
			input.event.usageEffectRetryAt,
			delivery.usageEffectRetryAt,
		) ||
		!optionalMatches(input.event.usageEffectLease, delivery.usageEffectLease) ||
		!optionalMatches(
			input.event.usageEffectLeaseAt,
			delivery.usageEffectLeaseAt,
		) ||
		!optionalMatches(
			input.event.subscriptionEffectState,
			delivery.subscriptionEffectState,
		) ||
		!optionalMatches(
			input.event.subscriptionEffectLease,
			delivery.subscriptionEffectLease,
		) ||
		!optionalMatches(
			input.event.subscriptionEffectLeaseAt,
			delivery.subscriptionEffectLeaseAt,
		) ||
		!optionalMatches(
			input.event.subscriptionEffectRetryAt,
			delivery.subscriptionEffectRetryAt,
		) ||
		!optionalMatches(
			input.event.subscriptionEffectAttemptCount,
			delivery.subscriptionEffectAttemptCount,
		) ||
		!optionalMatches(
			input.event.subscriptionEffectDeadLetterAt,
			delivery.subscriptionEffectDeadLetterAt,
		) ||
		!optionalMatches(
			input.event.subscriptionEffectLastError,
			delivery.subscriptionEffectLastError,
		)
	) {
		throw new Error(
			'USER inbound bootstrap requires a valid owner-bound complete snapshot.',
		)
	}
}

/**
 * Reject authority-bearing lifecycle/dedupe snapshots from normal mirror
 * upserts. The only inbound-provider exception is the bounded pre-claim audit.
 */
export function shouldSkipMailboxDeliveryEventWrite(
	sql: SqlStorage,
	input: {
		event: MailboxDeliveryEventInput
	},
) {
	if (!isUserInboundAuthorityEvent(input.event)) return false
	if (!isPreClaimAuditSnapshot(input.event)) {
		throw new Error(
			'USER inbound delivery events require the missing-row bootstrap RPC.',
		)
	}
	const eventId = assertMailboxNonEmptyString(input.event.id, 'event.id')
	const existing = readMailboxDeliveryEvent(sql, eventId)
	return existing != null && !isPreClaimAuditSnapshot(existing)
}
