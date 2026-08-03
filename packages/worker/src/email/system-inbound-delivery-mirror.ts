import { systemEmailOwnerId } from './email-owner.ts'
import {
	systemEmailDeliveryEventColumns,
	systemEmailGraphColumnContracts,
} from './system-email-graph-columns.ts'
import {
	commitSystemEmailGraphMutations,
	systemEmailGraphContract,
	type SystemEmailGraphMutation,
} from './system-email-graph-transaction.ts'

const deliveryEventContract = systemEmailGraphContract(
	systemEmailGraphColumnContracts,
	'deliveryEvents',
)
if (
	systemEmailDeliveryEventColumns[0] !== 'id' ||
	systemEmailDeliveryEventColumns[1] !== 'message_id'
) {
	throw new Error(
		'systemEmailDeliveryEventColumns must start with id, message_id.',
	)
}
const insertColumns = [
	'id',
	'message_id',
	'user_id',
	...systemEmailDeliveryEventColumns.slice(2),
]
const selectColumns = [
	'id',
	'message_id',
	'?',
	...systemEmailDeliveryEventColumns.slice(2),
]
const updateColumns = systemEmailDeliveryEventColumns.filter(
	(column) => column !== 'id',
)

/**
 * Complete compatibility upsert for one authoritative event. Callers place
 * this immediately after the dedicated mutation in the same transactional D1
 * batch, so a mirror failure rolls back the authority write. The user_id CASE
 * deliberately violates its NOT NULL constraint on a same-id foreign-owner
 * collision instead of allowing a system write to take over a user row.
 */
export function legacySystemInboundEventMirrorStatement(
	db: D1Database,
	eventId: string,
) {
	return db
		.prepare(
			`INSERT INTO email_delivery_events (${insertColumns.join(', ')})
			SELECT ${selectColumns.join(', ')}
			FROM system_email_delivery_events event
			WHERE id = ?
				AND (event.inbox_id IS NULL OR EXISTS (
					SELECT 1 FROM email_inboxes inbox
					WHERE inbox.id = event.inbox_id AND inbox.user_id = ?
				))
				AND (event.message_id IS NULL OR EXISTS (
					SELECT 1 FROM email_messages message
					WHERE message.id = event.message_id AND message.user_id = ?
				))
			ON CONFLICT(id) DO UPDATE SET
				${updateColumns
					.map((column) => `${column} = excluded.${column}`)
					.join(',\n\t\t\t\t')},
				user_id = CASE
					WHEN email_delivery_events.user_id = excluded.user_id
					THEN excluded.user_id
					ELSE NULL
				END`,
		)
		.bind(systemEmailOwnerId, eventId, systemEmailOwnerId, systemEmailOwnerId)
}

export function systemInboundEventMutation(input: {
	db: D1Database
	eventId: string
	dedicated: D1PreparedStatement
	legacy?: D1PreparedStatement
	expectation?: 'parity' | 'present' | 'absent'
}): SystemEmailGraphMutation {
	return {
		contract: deliveryEventContract,
		id: input.eventId,
		dedicated: input.dedicated,
		legacy:
			input.legacy ??
			legacySystemInboundEventMirrorStatement(input.db, input.eventId),
		expectation: input.expectation,
	}
}

export async function commitSystemInboundEventMutation(input: {
	db: D1Database
	eventId: string
	dedicated: D1PreparedStatement
	legacy?: D1PreparedStatement
	before?: ReadonlyArray<D1PreparedStatement>
	after?: ReadonlyArray<D1PreparedStatement>
	expectation?: 'parity' | 'present' | 'absent'
}) {
	const { results, mutationResults } = await commitSystemEmailGraphMutations({
		db: input.db,
		before: input.before,
		mutations: [systemInboundEventMutation(input)],
		after: input.after,
	})
	return {
		results,
		dedicatedResult: mutationResults[0]?.dedicated,
		legacyResult: mutationResults[0]?.legacy,
	}
}
