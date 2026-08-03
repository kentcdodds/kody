import { queryD1Database } from './d1-import-api.ts'
import { type ApiOptions } from './d1-export-api.ts'
import { BackupError } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropSnapshot,
} from './backup-types.ts'

export const mailboxPreDropSnapshotCtes = `WITH frozen_owners(user_id) AS (
	SELECT user_id FROM email_threads WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_messages WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_delivery_events WHERE user_id != 'system:email'
),
current_snapshot AS (
	SELECT
		(SELECT COUNT(*) FROM email_user_graph_authority
			WHERE singleton = 1
				AND max_parity_age_hours = 6
				AND julianday(frozen_at) IS NOT NULL) AS authority_marker_count,
		(SELECT frozen_at FROM email_user_graph_authority
			WHERE singleton = 1 LIMIT 1) AS authority_frozen_at,
		(SELECT owner_count FROM email_user_graph_authority
			WHERE singleton = 1 LIMIT 1) AS authority_owner_count,
		(SELECT COUNT(*) FROM frozen_owners) AS owner_count,
		(SELECT COUNT(*) FROM email_threads
			WHERE user_id != 'system:email') AS thread_count,
		(SELECT COUNT(*) FROM email_messages
			WHERE user_id != 'system:email') AS message_count,
		(SELECT COUNT(*) FROM email_attachments attachment
			INNER JOIN email_messages message ON message.id = attachment.message_id
			WHERE message.user_id != 'system:email') AS attachment_count,
		(SELECT COUNT(*) FROM email_delivery_events
			WHERE user_id != 'system:email') AS event_count,
		(SELECT COUNT(*) FROM email_outbound_provider_index_repair_owners)
			AS provider_repair_count,
		(SELECT COUNT(*) FROM email_inbound_due_owners
			WHERE reason = 'cutover-audit') AS cutover_audit_count,
		CASE WHEN (
			SELECT COUNT(*) FROM system_email_graph_authority
			WHERE singleton = 1
				AND authority = 'dedicated'
				AND graph_mismatch_count = 0
				AND provider_link_count = 0
		) = 1 THEN 0 ELSE 1 END AS system_marker_violation_count,
		(
			(SELECT COUNT(*) FROM email_outbound_provider_index provider_index
				WHERE provider_index.user_id = 'system:email'
					OR EXISTS (
						SELECT 1 FROM email_messages message
						WHERE message.id = provider_index.message_id
							AND message.user_id = 'system:email'
					))
			+ (SELECT COUNT(*) FROM email_messages
				WHERE user_id = 'system:email'
					AND provider_message_id IS NOT NULL)
			+ (SELECT COUNT(*) FROM system_email_messages
				WHERE provider_message_id IS NOT NULL)
		) AS system_provider_link_count,
		(
			(SELECT COUNT(*) FROM system_email_threads thread
				WHERE thread.inbox_id IS NOT NULL
					AND NOT EXISTS (
						SELECT 1 FROM email_inboxes inbox
						WHERE inbox.id = thread.inbox_id
							AND inbox.user_id = 'system:email'
					))
			+ (SELECT COUNT(*) FROM system_email_messages message
				WHERE (message.inbox_id IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM email_inboxes inbox
						WHERE inbox.id = message.inbox_id
							AND inbox.user_id = 'system:email'
					))
					OR (message.sender_identity_id IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM email_sender_identities sender
						WHERE sender.id = message.sender_identity_id
							AND sender.user_id = 'system:email'
					))
					OR (message.thread_id IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM system_email_threads thread
						WHERE thread.id = message.thread_id
					)))
			+ (SELECT COUNT(*) FROM system_email_attachments attachment
				WHERE NOT EXISTS (
					SELECT 1 FROM system_email_messages message
					WHERE message.id = attachment.message_id
				))
			+ (SELECT COUNT(*) FROM system_email_delivery_events event
				WHERE (event.inbox_id IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM email_inboxes inbox
						WHERE inbox.id = event.inbox_id
							AND inbox.user_id = 'system:email'
					))
					OR (event.message_id IS NOT NULL AND NOT EXISTS (
						SELECT 1 FROM system_email_messages message
						WHERE message.id = event.message_id
					)))
		) AS system_reference_violation_count
)`

export const mailboxPreDropSnapshotSql = `${mailboxPreDropSnapshotCtes}
SELECT * FROM current_snapshot`

type SnapshotRow = {
	authority_marker_count: number
	authority_frozen_at: string
	authority_owner_count: number
	owner_count: number
	thread_count: number
	message_count: number
	attachment_count: number
	event_count: number
	provider_repair_count: number
	cutover_audit_count: number
	system_marker_violation_count: number
	system_provider_link_count: number
	system_reference_violation_count: number
}

function nonnegativeInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && Number(value) >= 0
		? Number(value)
		: null
}

function parseHealthySnapshot(
	rows: Array<Record<string, unknown>>,
): MailboxPreDropSnapshot {
	const row = rows.length === 1 ? (rows[0] as Partial<SnapshotRow>) : undefined
	const authorityOwnerCount = nonnegativeInteger(row?.authority_owner_count)
	const ownerCount = nonnegativeInteger(row?.owner_count)
	const threadCount = nonnegativeInteger(row?.thread_count)
	const messageCount = nonnegativeInteger(row?.message_count)
	const attachmentCount = nonnegativeInteger(row?.attachment_count)
	const eventCount = nonnegativeInteger(row?.event_count)
	if (
		row === undefined ||
		row.authority_marker_count !== 1 ||
		typeof row.authority_frozen_at !== 'string' ||
		!Number.isFinite(Date.parse(row.authority_frozen_at)) ||
		authorityOwnerCount === null ||
		ownerCount === null ||
		ownerCount > authorityOwnerCount ||
		threadCount === null ||
		messageCount === null ||
		attachmentCount === null ||
		eventCount === null ||
		row.provider_repair_count !== 0 ||
		row.cutover_audit_count !== 0 ||
		row.system_marker_violation_count !== 0 ||
		row.system_provider_link_count !== 0 ||
		row.system_reference_violation_count !== 0
	) {
		throw new BackupError(
			'mailbox-pre-drop-preflight-failed',
			'mailbox legacy graph pre-drop health gates are not satisfied',
		)
	}
	return {
		authorityFrozenAt: row.authority_frozen_at,
		authorityOwnerCount,
		ownerCount,
		threadCount,
		messageCount,
		attachmentCount,
		eventCount,
	}
}

export async function readMailboxPreDropSnapshot(
	env: BackupEnvironment,
	options: ApiOptions = {},
): Promise<MailboxPreDropSnapshot> {
	const rows = await queryD1Database({
		accountId: env.SOURCE_ACCOUNT_ID,
		databaseId: env.SOURCE_DATABASE_ID,
		token: env.CLOUDFLARE_API_TOKEN,
		sql: mailboxPreDropSnapshotSql,
		options,
	})
	return parseHealthySnapshot(rows)
}

export function assertMailboxPreDropSnapshotUnchanged(
	before: MailboxPreDropSnapshot,
	after: MailboxPreDropSnapshot,
): void {
	for (const key of Object.keys(before) as Array<
		keyof MailboxPreDropSnapshot
	>) {
		if (before[key] !== after[key]) {
			throw new BackupError(
				'mailbox-pre-drop-snapshot-drift',
				'mailbox legacy graph marker or exact counts changed during export',
			)
		}
	}
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

export function mailboxPreDropSnapshotMatchesSql(
	snapshot: MailboxPreDropSnapshot,
): string {
	return `authority_marker_count = 1
		AND authority_frozen_at = ${sqlLiteral(snapshot.authorityFrozenAt)}
		AND authority_owner_count = ${String(snapshot.authorityOwnerCount)}
		AND owner_count = ${String(snapshot.ownerCount)}
		AND thread_count = ${String(snapshot.threadCount)}
		AND message_count = ${String(snapshot.messageCount)}
		AND attachment_count = ${String(snapshot.attachmentCount)}
		AND event_count = ${String(snapshot.eventCount)}
		AND provider_repair_count = 0
		AND cutover_audit_count = 0
		AND system_marker_violation_count = 0
		AND system_provider_link_count = 0
		AND system_reference_violation_count = 0`
}
