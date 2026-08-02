import {
	systemEmailGraphColumnContracts,
	type SystemEmailGraphColumnContract,
	type SystemEmailGraphTableKey,
} from './system-email-graph-columns.ts'

export const systemEmailGraphLegacyCtes = `
legacy_threads AS (
	SELECT *
	FROM email_threads
	WHERE user_id = ?1
),
valid_threads AS (
	SELECT thread.*
	FROM legacy_threads thread
	WHERE thread.inbox_id IS NULL
		OR EXISTS (
			SELECT 1
			FROM email_inboxes inbox
			WHERE inbox.id = thread.inbox_id AND inbox.user_id = ?1
		)
),
legacy_messages AS (
	SELECT *
	FROM email_messages
	WHERE user_id = ?1
),
valid_messages AS (
	SELECT message.*
	FROM legacy_messages message
	WHERE (
			message.inbox_id IS NULL
			OR EXISTS (
				SELECT 1
				FROM email_inboxes inbox
				WHERE inbox.id = message.inbox_id AND inbox.user_id = ?1
			)
		)
		AND (
			message.sender_identity_id IS NULL
			OR EXISTS (
				SELECT 1
				FROM email_sender_identities sender
				WHERE sender.id = message.sender_identity_id
					AND sender.user_id = ?1
			)
		)
		AND (
			message.thread_id IS NULL
			OR EXISTS (
				SELECT 1
				FROM valid_threads thread
				WHERE thread.id = message.thread_id
			)
		)
),
legacy_attachments AS (
	SELECT attachment.*
	FROM email_attachments attachment
	INNER JOIN legacy_messages message ON message.id = attachment.message_id
),
valid_attachments AS (
	SELECT attachment.*
	FROM email_attachments attachment
	INNER JOIN valid_messages message ON message.id = attachment.message_id
),
legacy_events AS (
	SELECT *
	FROM email_delivery_events
	WHERE user_id = ?1
),
valid_events AS (
	SELECT event.*
	FROM legacy_events event
	WHERE (
			event.inbox_id IS NULL
			OR EXISTS (
				SELECT 1
				FROM email_inboxes inbox
				WHERE inbox.id = event.inbox_id AND inbox.user_id = ?1
			)
		)
		AND (
			event.message_id IS NULL
			OR EXISTS (
				SELECT 1
				FROM valid_messages message
				WHERE message.id = event.message_id
			)
		)
)`

const sourceCteByKey: Readonly<Record<SystemEmailGraphTableKey, string>> = {
	threads: 'valid_threads',
	messages: 'valid_messages',
	attachments: 'valid_attachments',
	deliveryEvents: 'valid_events',
}

const legacyCteByKey: Readonly<Record<SystemEmailGraphTableKey, string>> = {
	threads: 'legacy_threads',
	messages: 'legacy_messages',
	attachments: 'legacy_attachments',
	deliveryEvents: 'legacy_events',
}

export function systemEmailGraphSourceCte(
	key: SystemEmailGraphTableKey,
): string {
	return sourceCteByKey[key]
}

export function systemEmailGraphLegacyCte(
	key: SystemEmailGraphTableKey,
): string {
	return legacyCteByKey[key]
}

export function buildSystemEmailGraphUpsertSql(
	contract: SystemEmailGraphColumnContract,
): string {
	const columns = contract.columns.join(', ')
	const updates = contract.columns
		.filter((column) => column !== 'id')
		.map((column) => `${column} = excluded.${column}`)
		.join(', ')
	const changed = contract.columns
		.filter((column) => column !== 'id')
		.map(
			(column) =>
				`${contract.dedicatedTable}.${column} IS NOT excluded.${column}`,
		)
		.join(' OR ')
	return `WITH ${systemEmailGraphLegacyCtes}
		INSERT INTO ${contract.dedicatedTable} (${columns})
		SELECT ${columns}
		FROM ${systemEmailGraphSourceCte(contract.key)}
		WHERE 1
		ON CONFLICT(id) DO UPDATE SET ${updates}
		WHERE ${changed}`
}

export function buildSystemEmailGraphDeleteDriftSql(
	contract: SystemEmailGraphColumnContract,
): string {
	return `WITH ${systemEmailGraphLegacyCtes}
		DELETE FROM ${contract.dedicatedTable}
		WHERE NOT EXISTS (
			SELECT 1
			FROM ${systemEmailGraphSourceCte(contract.key)} legacy
			WHERE legacy.id = ${contract.dedicatedTable}.id
		)`
}

export function systemEmailGraphContract(
	key: SystemEmailGraphTableKey,
): SystemEmailGraphColumnContract {
	const contract = systemEmailGraphColumnContracts.find(
		(candidate) => candidate.key === key,
	)
	if (!contract) throw new Error(`Missing system email graph contract: ${key}`)
	return contract
}
