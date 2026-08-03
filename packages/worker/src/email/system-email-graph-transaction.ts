import { systemEmailOwnerId } from './email-owner.ts'
import { systemEmailAuthorityGuardStatement } from './system-email-authority.ts'
import {
	type SystemEmailGraphColumnContract,
	type SystemEmailGraphTableKey,
} from './system-email-graph-columns.ts'

function legacySourceSql(contract: SystemEmailGraphColumnContract) {
	switch (contract.key) {
		case 'attachments':
			return `SELECT ${contract.columns.map((column) => `legacy.${column}`).join(', ')}
				FROM email_attachments legacy
				INNER JOIN email_messages owner ON owner.id = legacy.message_id
				WHERE owner.user_id = ? AND legacy.id = ?`
		case 'threads':
		case 'messages':
		case 'deliveryEvents':
			return `SELECT ${contract.columns.join(', ')}
				FROM ${contract.legacyTable}
				WHERE user_id = ? AND id = ?`
		default: {
			const exhaustive: never = contract.key
			throw new Error(`Unsupported system email graph table: ${exhaustive}`)
		}
	}
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
	expectation: 'parity' | 'absent'
}) {
	const violation =
		input.expectation === 'absent'
			? `EXISTS (SELECT 1 FROM dedicated)
				OR EXISTS (SELECT 1 FROM legacy)`
			: `(
					EXISTS (SELECT 1 FROM dedicated)
					OR EXISTS (SELECT 1 FROM legacy)
				) AND NOT EXISTS (
					SELECT 1
					FROM dedicated
					INNER JOIN legacy ON legacy.id = dedicated.id
					WHERE ${mirrorParityExpression(input.contract)}
				)`
	return input.db
		.prepare(
			`WITH
			dedicated AS (
				SELECT ${input.contract.columns.join(', ')}
				FROM ${input.contract.dedicatedTable}
				WHERE id = ?
			),
			legacy AS (${legacySourceSql(input.contract)})
			INSERT INTO system_email_graph_authority (
				singleton, authority, cutover_at, provider_link_count
			)
			SELECT 2, 'dedicated', CURRENT_TIMESTAMP, 0
			WHERE ${violation}`,
		)
		.bind(input.id, systemEmailOwnerId, input.id)
}

export type SystemEmailGraphMutation = {
	contract: SystemEmailGraphColumnContract
	id: string
	dedicated: D1PreparedStatement
	legacy: D1PreparedStatement
	expectation?: 'parity' | 'absent'
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
	const statements = [
		...(input.before ?? []),
		...input.mutations.flatMap((mutation) =>
			composeSystemEmailGraphMutation(input.db, mutation),
		),
		...(input.after ?? []),
		systemEmailAuthorityGuardStatement(input.db),
	]
	return await input.db.batch(statements)
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
				singleton, authority, cutover_at, provider_link_count
			)
			SELECT 2, 'dedicated', CURRENT_TIMESTAMP, 0
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
