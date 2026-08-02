import {
	mailboxInboundDedupePointerId,
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
} from './mailbox-inbound-ledger.ts'
import { parseStrictInboundDeliveryDetailJson } from './inbound-delivery.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxDeliveryEventInput,
} from './mailbox-types.ts'

function isUserInboundAuthorityEvent(event: MailboxDeliveryEventInput) {
	return (
		event.provider === mailboxInboundProvider ||
		event.provider === mailboxInboundDedupeProvider
	)
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
		throw new Error(
			'USER inbound delivery events require the missing-row bootstrap intent.',
		)
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

export function assertMailboxD1DeliveryEventBatch(
	events: Array<MailboxDeliveryEventInput>,
) {
	if (events.some(isUserInboundAuthorityEvent)) {
		throw new Error(
			'USER inbound delivery events cannot use the D1-authoritative batch mirror.',
		)
	}
}
