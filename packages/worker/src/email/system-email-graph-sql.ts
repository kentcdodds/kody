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

export function buildLegacySystemEmailGraphUpsertSql(
	contract: SystemEmailGraphColumnContract,
): string {
	if (contract.columns[0] !== 'id') {
		throw new Error(
			`System email graph contract ${contract.key} must start with id.`,
		)
	}
	const columns = contract.columns.join(', ')
	const updates = contract.columns
		.filter((column) => column !== 'id')
		.map((column) => `${column} = excluded.${column}`)
		.join(', ')
	const changed = contract.columns
		.filter((column) => column !== 'id')
		.map(
			(column) => `${contract.legacyTable}.${column} IS NOT excluded.${column}`,
		)
		.join(' OR ')
	if (contract.key === 'attachments') {
		return `INSERT INTO email_attachments (${columns})
			SELECT ${columns} FROM system_email_attachments
			WHERE EXISTS (
				SELECT 1 FROM system_email_messages dedicated_parent
				WHERE dedicated_parent.id = system_email_attachments.message_id
			) AND EXISTS (
				SELECT 1 FROM email_messages legacy_parent
				WHERE legacy_parent.id = system_email_attachments.message_id
					AND legacy_parent.user_id = ?1
			)
			ON CONFLICT(id) DO UPDATE SET ${updates}
			WHERE EXISTS (
				SELECT 1 FROM email_messages
				WHERE id = email_attachments.message_id AND user_id = ?1
			) AND (${changed})`
	}
	const legacyColumns = [
		...contract.columns.slice(0, 1),
		'user_id',
		...contract.columns.slice(1),
	].join(', ')
	const selected = ['id', '?1', ...contract.columns.slice(1)].join(', ')
	const referenceFence = (() => {
		switch (contract.key) {
			case 'threads':
				return `(inbox_id IS NULL OR EXISTS (
					SELECT 1 FROM email_inboxes inbox
					WHERE inbox.id = system_email_threads.inbox_id
						AND inbox.user_id = ?1
				))`
			case 'messages':
				return `(inbox_id IS NULL OR EXISTS (
						SELECT 1 FROM email_inboxes inbox
						WHERE inbox.id = system_email_messages.inbox_id
							AND inbox.user_id = ?1
					))
					AND (sender_identity_id IS NULL OR EXISTS (
						SELECT 1 FROM email_sender_identities sender
						WHERE sender.id = system_email_messages.sender_identity_id
							AND sender.user_id = ?1
					))
					AND (thread_id IS NULL OR (
						EXISTS (
							SELECT 1 FROM system_email_threads dedicated_thread
							WHERE dedicated_thread.id = system_email_messages.thread_id
						)
						AND EXISTS (
							SELECT 1 FROM email_threads legacy_thread
							WHERE legacy_thread.id = system_email_messages.thread_id
								AND legacy_thread.user_id = ?1
						)
					))`
			case 'deliveryEvents':
				return `(inbox_id IS NULL OR EXISTS (
						SELECT 1 FROM email_inboxes inbox
						WHERE inbox.id = system_email_delivery_events.inbox_id
							AND inbox.user_id = ?1
					))
					AND (message_id IS NULL OR (
						EXISTS (
							SELECT 1 FROM system_email_messages dedicated_message
							WHERE dedicated_message.id =
								system_email_delivery_events.message_id
						)
						AND EXISTS (
							SELECT 1 FROM email_messages legacy_message
							WHERE legacy_message.id =
								system_email_delivery_events.message_id
								AND legacy_message.user_id = ?1
						)
					))`
			default: {
				const exhaustive: never = contract.key
				throw new Error(
					`Unsupported system email graph table: ${String(exhaustive)}`,
				)
			}
		}
	})()
	return `INSERT INTO ${contract.legacyTable} (${legacyColumns})
		SELECT ${selected} FROM ${contract.dedicatedTable}
		WHERE ${referenceFence}
		ON CONFLICT(id) DO UPDATE SET ${updates}
		WHERE ${contract.legacyTable}.user_id = ?1 AND (${changed})`
}

export function buildLegacySystemEmailGraphDeleteDriftSql(
	contract: SystemEmailGraphColumnContract,
): string {
	if (contract.key === 'attachments') {
		return `DELETE FROM email_attachments
			WHERE EXISTS (
				SELECT 1 FROM email_messages
				WHERE id = email_attachments.message_id AND user_id = ?1
			)
				AND NOT EXISTS (
					SELECT 1 FROM system_email_attachments
					WHERE id = email_attachments.id
				)`
	}
	return `DELETE FROM ${contract.legacyTable}
		WHERE user_id = ?1
			AND NOT EXISTS (
				SELECT 1 FROM ${contract.dedicatedTable}
				WHERE id = ${contract.legacyTable}.id
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
