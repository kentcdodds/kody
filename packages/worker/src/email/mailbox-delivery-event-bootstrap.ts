import { writeMailboxDeliveryEventRow } from './mailbox-delivery-events.ts'
import {
	assertUserInboundLegacyBootstrapSnapshot,
	hasMalformedUserInboundBootstrapSchedule,
} from './mailbox-inbound-bootstrap.ts'
import {
	assertMailboxNonEmptyString,
	mailboxUpsertDeliveryEventsMax,
	type MailboxBootstrapDeliveryEventsResult,
	type MailboxDeliveryEventInput,
} from './mailbox-types.ts'

/**
 * Missing-only legacy USER inbound bootstrap inside the caller's transaction.
 * Validation failure throws so transactionSync rolls back every prior insert.
 */
export function bootstrapMailboxDeliveryEvents(
	sql: SqlStorage,
	input: {
		ownerId: string
		events: Array<MailboxDeliveryEventInput>
	},
): MailboxBootstrapDeliveryEventsResult {
	if (!Array.isArray(input.events) || input.events.length === 0) {
		throw new Error('Mailbox bootstrapDeliveryEvents events must be non-empty.')
	}
	if (input.events.length > mailboxUpsertDeliveryEventsMax) {
		throw new Error(
			`Mailbox bootstrapDeliveryEvents events exceed max of ${mailboxUpsertDeliveryEventsMax}.`,
		)
	}
	const result: MailboxBootstrapDeliveryEventsResult = {
		inserted: 0,
		existing: 0,
		skipped: 0,
		results: [],
	}
	for (const event of input.events) {
		const eventId = assertMailboxNonEmptyString(event.id, 'event.id')
		if (hasMalformedUserInboundBootstrapSchedule(event)) {
			result.skipped += 1
			result.results.push({ eventId, status: 'skipped' })
			continue
		}
		assertUserInboundLegacyBootstrapSnapshot({
			ownerId: input.ownerId,
			event,
		})
		const existing = sql
			.exec(
				`SELECT id FROM email_delivery_events WHERE id = ? LIMIT 1`,
				eventId,
			)
			.toArray()
		if (existing.length > 0) {
			result.existing += 1
			result.results.push({ eventId, status: 'existing' })
			continue
		}
		const write = writeMailboxDeliveryEventRow(sql, event)
		if (write.inserted) {
			result.inserted += 1
			result.results.push({ eventId, status: 'inserted' })
		} else {
			result.skipped += 1
			result.results.push({ eventId, status: 'skipped' })
		}
	}
	return result
}
