import {
	mailboxInboundDedupePointerId,
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
} from './mailbox-inbound-ledger.ts'
import { parseStrictInboundDeliveryDetailJson } from './inbound-delivery.ts'
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

function isPreClaimAuditSnapshot(
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
 * Fence the only D1 → Mailbox USER inbound bridge. Bootstrap accepts a
 * validated complete snapshot only when the owner-bound row is still missing.
 */
export function shouldSkipMailboxDeliveryEventWrite(
	sql: SqlStorage,
	input: {
		ownerId: string
		event: MailboxDeliveryEventInput
		intent?: 'user-inbound-bootstrap'
		hasLatestDeliveryStatus: boolean
	},
) {
	const inboundAuthorityEvent = isUserInboundAuthorityEvent(input.event)
	if (inboundAuthorityEvent && input.intent !== 'user-inbound-bootstrap') {
		if (!isPreClaimAuditSnapshot(input.event)) {
			throw new Error(
				'USER inbound delivery events require the missing-row bootstrap intent.',
			)
		}
		const existing = readMailboxDeliveryEvent(sql, input.event.id)
		return existing != null && !isPreClaimAuditSnapshot(existing)
	}
	if (!inboundAuthorityEvent && input.intent === 'user-inbound-bootstrap') {
		throw new Error(
			'USER inbound bootstrap intent requires an inbound delivery provider.',
		)
	}
	if (input.intent !== 'user-inbound-bootstrap') return false
	if (input.hasLatestDeliveryStatus) {
		throw new Error(
			'USER inbound bootstrap cannot update latest delivery status.',
		)
	}
	const delivery = parseStrictInboundDeliveryDetailJson(input.event.detailJson)
	const expectedEventId =
		input.event.provider === mailboxInboundDedupeProvider && delivery
			? mailboxInboundDedupePointerId(delivery.fingerprint)
			: delivery?.deliveryId
	if (
		!delivery ||
		delivery.userId !== input.ownerId ||
		delivery.provider !== mailboxInboundProvider ||
		input.event.id !== expectedEventId ||
		input.event.state !== delivery.state ||
		input.event.fingerprint !== delivery.fingerprint
	) {
		throw new Error(
			'USER inbound bootstrap requires a valid owner-bound complete snapshot.',
		)
	}
	const eventId = assertMailboxNonEmptyString(input.event.id, 'event.id')
	return (
		sql
			.exec(
				`SELECT id FROM email_delivery_events WHERE id = ? LIMIT 1`,
				eventId,
			)
			.toArray().length > 0
	)
}
