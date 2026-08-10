import { writeMailboxDeliveryEventRow } from './mailbox-delivery-events.ts'
import { shouldSkipMailboxDeliveryEventWrite } from './mailbox-inbound-bootstrap.ts'
import {
	assertMailboxNonEmptyString,
	mailboxUpsertDeliveryEventsMax,
	type MailboxDeliveryEventInput,
	type MailboxUpsertDeliveryEventsResult,
} from './mailbox-types.ts'

/** Normal bounded delivery-event upsert inside the caller's transaction. */
export function upsertMailboxDeliveryEvents(
	sql: SqlStorage,
	events: Array<MailboxDeliveryEventInput>,
	options: { restore?: true } = {},
): MailboxUpsertDeliveryEventsResult {
	if (!Array.isArray(events) || events.length === 0) {
		throw new Error('Mailbox upsertDeliveryEvents events must be non-empty.')
	}
	if (events.length > mailboxUpsertDeliveryEventsMax) {
		throw new Error(
			`Mailbox upsertDeliveryEvents events exceed max of ${mailboxUpsertDeliveryEventsMax}.`,
		)
	}
	const results: MailboxUpsertDeliveryEventsResult['results'] = []
	for (const event of events) {
		const eventId = assertMailboxNonEmptyString(event.id, 'event.id')
		if (
			!options.restore &&
			shouldSkipMailboxDeliveryEventWrite(sql, { event })
		) {
			results.push({ eventId, inserted: false, accepted: false })
			continue
		}
		results.push({ eventId, ...writeMailboxDeliveryEventRow(sql, event) })
	}
	return { results }
}
