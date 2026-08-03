import { systemEmailOwnerId } from './email-owner.ts'
import { systemEmailAuthorityGuardStatement } from './system-email-authority.ts'
import {
	systemEmailGraphColumnContracts,
	type SystemEmailGraphColumnContract,
	type SystemEmailGraphTableKey,
} from './system-email-graph-columns.ts'

function legacySourceSql(contract: SystemEmailGraphColumnContract) {
	switch (contract.key) {
		case 'attachments':
			return `SELECT
					${contract.columns.map((column) => `legacy.${column}`).join(', ')},
					EXISTS (
						SELECT 1 FROM email_messages parent
						WHERE parent.id = legacy.message_id AND parent.user_id = ?2
					) AS references_valid
				FROM email_attachments legacy
				INNER JOIN email_messages owner ON owner.id = legacy.message_id
				WHERE owner.user_id = ?2 AND legacy.id = ?3`
		case 'threads':
			return `SELECT ${contract.columns.join(', ')},
					(
						inbox_id IS NULL OR EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = email_threads.inbox_id
								AND inbox.user_id = ?2
						)
					) AS references_valid
				FROM email_threads
				WHERE user_id = ?2 AND id = ?3`
		case 'messages':
			return `SELECT ${contract.columns.join(', ')},
					(
						(inbox_id IS NULL OR EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = email_messages.inbox_id
								AND inbox.user_id = ?2
						))
						AND (sender_identity_id IS NULL OR EXISTS (
							SELECT 1 FROM email_sender_identities sender
							WHERE sender.id = email_messages.sender_identity_id
								AND sender.user_id = ?2
						))
						AND (thread_id IS NULL OR EXISTS (
							SELECT 1 FROM email_threads thread
							WHERE thread.id = email_messages.thread_id
								AND thread.user_id = ?2
						))
					) AS references_valid
				FROM email_messages
				WHERE user_id = ?2 AND id = ?3`
		case 'deliveryEvents':
			return `SELECT ${contract.columns.join(', ')},
					(
						(inbox_id IS NULL OR EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = email_delivery_events.inbox_id
								AND inbox.user_id = ?2
						))
						AND (message_id IS NULL OR EXISTS (
							SELECT 1 FROM email_messages message
							WHERE message.id = email_delivery_events.message_id
								AND message.user_id = ?2
						))
					) AS references_valid
				FROM ${contract.legacyTable}
				WHERE user_id = ?2 AND id = ?3`
		default: {
			const exhaustive: never = contract.key
			throw new Error(`Unsupported system email graph table: ${exhaustive}`)
		}
	}
}

function dedicatedReferenceValiditySql(
	contract: SystemEmailGraphColumnContract,
	alias: string,
	ownerPlaceholder = '?2',
) {
	switch (contract.key) {
		case 'threads':
			return `(
				${alias}.inbox_id IS NULL OR EXISTS (
					SELECT 1 FROM email_inboxes inbox
					WHERE inbox.id = ${alias}.inbox_id
						AND inbox.user_id = ${ownerPlaceholder}
				)
			)`
		case 'messages':
			return `(
				(${alias}.inbox_id IS NULL OR EXISTS (
					SELECT 1 FROM email_inboxes inbox
					WHERE inbox.id = ${alias}.inbox_id
						AND inbox.user_id = ${ownerPlaceholder}
				))
				AND (${alias}.sender_identity_id IS NULL OR EXISTS (
					SELECT 1 FROM email_sender_identities sender
					WHERE sender.id = ${alias}.sender_identity_id
						AND sender.user_id = ${ownerPlaceholder}
				))
				AND (${alias}.thread_id IS NULL OR EXISTS (
					SELECT 1 FROM system_email_threads thread
					WHERE thread.id = ${alias}.thread_id
				))
			)`
		case 'attachments':
			return `EXISTS (
				SELECT 1 FROM system_email_messages message
				WHERE message.id = ${alias}.message_id
			)`
		case 'deliveryEvents':
			return `(
				(${alias}.inbox_id IS NULL OR EXISTS (
					SELECT 1 FROM email_inboxes inbox
					WHERE inbox.id = ${alias}.inbox_id
						AND inbox.user_id = ${ownerPlaceholder}
				))
				AND (${alias}.message_id IS NULL OR EXISTS (
					SELECT 1 FROM system_email_messages message
					WHERE message.id = ${alias}.message_id
				))
			)`
		default: {
			const exhaustive: never = contract.key
			throw new Error(`Unsupported system email graph table: ${exhaustive}`)
		}
	}
}

/**
 * Reconcile preflight. A bad dedicated reference must abort before the first
 * compatibility-row delete/upsert, not merely appear in the post-report.
 */
export function systemEmailDedicatedReferenceGuardStatement(db: D1Database) {
	const violations = systemEmailGraphColumnContracts
		.map(
			(contract) =>
				`SELECT 1
			FROM ${contract.dedicatedTable} dedicated_row
			WHERE NOT ${dedicatedReferenceValiditySql(contract, 'dedicated_row', '?1')}`,
		)
		.join('\nUNION ALL\n')
	return db
		.prepare(
			`INSERT INTO system_email_graph_authority (
				singleton, authority, cutover_at, graph_mismatch_count,
				provider_link_count
			)
			SELECT 2, 'dedicated', CURRENT_TIMESTAMP, 0, 0
			WHERE EXISTS (
				SELECT 1 FROM (${violations}) violations LIMIT 1
			)`,
		)
		.bind(systemEmailOwnerId)
}

function mirrorParityExpression(contract: SystemEmailGraphColumnContract) {
	return contract.columns
		.map((column) => `legacy.${column} IS dedicated.${column}`)
		.join(' AND ')
}

function mirrorGuardStatement(input: {
	db: D1Database
	contract: SystemEmailGraphColumnContract
	id: string
	expectation: 'parity' | 'present' | 'absent'
}) {
	const violation =
		input.expectation === 'absent'
			? `EXISTS (SELECT 1 FROM dedicated)
				OR EXISTS (SELECT 1 FROM legacy)`
			: `${
					input.expectation === 'parity'
						? `(
					EXISTS (SELECT 1 FROM dedicated)
					OR EXISTS (SELECT 1 FROM legacy)
				) AND `
						: ''
				}NOT EXISTS (
					SELECT 1
					FROM dedicated
					INNER JOIN legacy ON legacy.id = dedicated.id
					WHERE dedicated.references_valid
						AND legacy.references_valid
						AND ${mirrorParityExpression(input.contract)}
				)`
	return input.db
		.prepare(
			`WITH
			dedicated AS (
				SELECT ${input.contract.columns.join(', ')},
					${dedicatedReferenceValiditySql(input.contract, 'dedicated_row')}
						AS references_valid
				FROM ${input.contract.dedicatedTable} dedicated_row
				WHERE id = ?1
			),
			legacy AS (${legacySourceSql(input.contract)})
			INSERT INTO system_email_graph_authority (
				singleton, authority, cutover_at, graph_mismatch_count,
				provider_link_count
			)
			SELECT 2, 'dedicated', CURRENT_TIMESTAMP, 0, 0
			WHERE ${violation}`,
		)
		.bind(input.id, systemEmailOwnerId, input.id)
}

export type SystemEmailGraphMutation = {
	contract: SystemEmailGraphColumnContract
	id: string
	dedicated: D1PreparedStatement
	legacy: D1PreparedStatement
	expectation?: 'parity' | 'present' | 'absent'
}

export function composeSystemEmailGraphMutation(
	db: D1Database,
	mutation: SystemEmailGraphMutation,
): Array<D1PreparedStatement> {
	return [
		mutation.dedicated,
		mutation.legacy,
		mirrorGuardStatement({
			db,
			contract: mutation.contract,
			id: mutation.id,
			expectation: mutation.expectation ?? 'parity',
		}),
	]
}

export async function commitSystemEmailGraphMutations(input: {
	db: D1Database
	mutations: ReadonlyArray<SystemEmailGraphMutation>
	before?: ReadonlyArray<D1PreparedStatement>
	after?: ReadonlyArray<D1PreparedStatement>
}) {
	const beforeCount = input.before?.length ?? 0
	const statements = [
		...(input.before ?? []),
		...input.mutations.flatMap((mutation) =>
			composeSystemEmailGraphMutation(input.db, mutation),
		),
		...(input.after ?? []),
		systemEmailAuthorityGuardStatement(input.db),
	]
	const results = await input.db.batch(statements)
	return {
		results,
		mutationResults: input.mutations.map((_mutation, index) => {
			const offset = beforeCount + index * 3
			return {
				dedicated: results[offset],
				legacy: results[offset + 1],
				guard: results[offset + 2],
			}
		}),
	}
}

function legacyBulkSourceSql(input: {
	contract: SystemEmailGraphColumnContract
	matchColumn: 'id' | 'message_id'
	placeholders: string
}) {
	if (input.contract.key === 'attachments') {
		return `SELECT legacy.id
			FROM email_attachments legacy
			INNER JOIN email_messages owner ON owner.id = legacy.message_id
			WHERE owner.user_id = ?
				AND legacy.${input.matchColumn} IN (${input.placeholders})`
	}
	return `SELECT id
		FROM ${input.contract.legacyTable}
		WHERE user_id = ? AND ${input.matchColumn} IN (${input.placeholders})`
}

export type SystemEmailGraphBulkDelete = {
	contract: SystemEmailGraphColumnContract
	ids: ReadonlyArray<string>
	matchColumn: 'id' | 'message_id'
	dedicated: D1PreparedStatement
	legacy: D1PreparedStatement
}

function bulkAbsenceGuardStatement(
	db: D1Database,
	mutation: SystemEmailGraphBulkDelete,
) {
	const placeholders = mutation.ids.map(() => '?').join(', ')
	return db
		.prepare(
			`WITH
			dedicated AS (
				SELECT id
				FROM ${mutation.contract.dedicatedTable}
				WHERE ${mutation.matchColumn} IN (${placeholders})
			),
			legacy AS (
				${legacyBulkSourceSql({
					contract: mutation.contract,
					matchColumn: mutation.matchColumn,
					placeholders,
				})}
			)
			INSERT INTO system_email_graph_authority (
				singleton, authority, cutover_at, graph_mismatch_count,
				provider_link_count
			)
			SELECT 2, 'dedicated', CURRENT_TIMESTAMP, 0, 0
			WHERE EXISTS (SELECT 1 FROM dedicated)
				OR EXISTS (SELECT 1 FROM legacy)`,
		)
		.bind(...mutation.ids, systemEmailOwnerId, ...mutation.ids)
}

export async function commitSystemEmailGraphBulkDeletes(input: {
	db: D1Database
	mutations: ReadonlyArray<SystemEmailGraphBulkDelete>
}) {
	const statements = [
		...input.mutations.flatMap((mutation) => [
			mutation.dedicated,
			mutation.legacy,
			bulkAbsenceGuardStatement(input.db, mutation),
		]),
		systemEmailAuthorityGuardStatement(input.db),
	]
	return await input.db.batch(statements)
}

export function systemEmailGraphContract(
	contracts: ReadonlyArray<SystemEmailGraphColumnContract>,
	key: SystemEmailGraphTableKey,
) {
	const contract = contracts.find((candidate) => candidate.key === key)
	if (!contract) {
		throw new Error(`Missing system email graph contract for ${key}.`)
	}
	return contract
}
