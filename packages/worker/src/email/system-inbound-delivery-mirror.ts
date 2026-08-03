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
			FROM system_email_delivery_events
			WHERE id = ?
			ON CONFLICT(id) DO UPDATE SET
				${updateColumns
					.map((column) =>
						column === 'message_id'
							? 'message_id = excluded.message_id'
							: `${column} = excluded.${column}`,
					)
					.join(',\n\t\t\t\t')},
				user_id = CASE
					WHEN email_delivery_events.user_id = excluded.user_id
					THEN excluded.user_id
					ELSE NULL
				END`,
		)
		.bind(systemEmailOwnerId, eventId)
}

export function systemInboundEventMutation(input: {
	db: D1Database
	eventId: string
	dedicated: D1PreparedStatement
	legacy?: D1PreparedStatement
	expectation?: 'parity' | 'absent'
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
	expectation?: 'parity' | 'absent'
}) {
	const beforeCount = input.before?.length ?? 0
	const results = await commitSystemEmailGraphMutations({
		db: input.db,
		before: input.before,
		mutations: [systemInboundEventMutation(input)],
		after: input.after,
	})
	return {
		results,
		dedicatedResult: results[beforeCount],
		legacyResult: results[beforeCount + 1],
	}
}
