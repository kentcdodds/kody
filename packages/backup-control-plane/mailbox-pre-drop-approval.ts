import {
	parseBackupManifest,
	serializeBackupManifest,
	type BackupManifest,
} from '@kody-internal/shared/backup-manifest.ts'

import { queryD1Database } from './d1-import-api.ts'
import { type ApiOptions } from './d1-export-api.ts'
import { verifyStoredObjectMatches } from './immutable-storage.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'
import { BackupError, objectKeyForPayload } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropApprovalReceipt,
	type MailboxPreDropRuntimePayload,
	type MailboxPreDropSnapshot,
} from './backup-types.ts'

const snapshotCtes = `WITH frozen_owners(user_id) AS (
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

export const mailboxPreDropSnapshotSql = `${snapshotCtes}
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

function decodeBase64(value: string): ArrayBuffer {
	try {
		const binary = atob(value)
		const bytes = new Uint8Array(binary.length)
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index)
		}
		return bytes.buffer
	} catch {
		throw new BackupError(
			'mailbox-pre-drop-manifest-signature-invalid',
			'manifest signature is not valid base64',
		)
	}
}

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function signatureSha256(manifest: BackupManifest): Promise<string> {
	const signature = decodeBase64(manifest.signature.value)
	if (signature.byteLength !== 64) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-signature-invalid',
			'manifest Ed25519 signature has an invalid length',
		)
	}
	return hex(await crypto.subtle.digest('SHA-256', signature))
}

export async function verifyMailboxPreDropBackup(input: {
	env: BackupEnvironment
	payload: MailboxPreDropRuntimePayload
}): Promise<{
	manifest: BackupManifest
	manifestSignatureSha256: string
}> {
	const manifestObject = await input.env.BACKUP_BUCKET.get(
		input.payload.manifestKey,
	)
	if (manifestObject === null) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-missing',
			'pre-drop backup manifest is missing',
		)
	}
	let manifest: BackupManifest
	const manifestText = await manifestObject.text()
	try {
		manifest = parseBackupManifest(JSON.parse(manifestText))
	} catch {
		throw new BackupError(
			'mailbox-pre-drop-manifest-invalid',
			'pre-drop backup manifest is invalid',
		)
	}
	if (manifestText !== serializeBackupManifest(manifest)) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-noncanonical',
			'pre-drop backup manifest bytes are not canonical',
		)
	}
	if (
		manifest.payload.source.accountId !== input.env.SOURCE_ACCOUNT_ID ||
		manifest.payload.source.databaseId !== input.env.SOURCE_DATABASE_ID ||
		manifest.payload.source.databaseName !== input.env.SOURCE_DATABASE_NAME ||
		manifest.payload.export.scheduledAt !== input.payload.requestedAt ||
		manifest.payload.buildCommit !== input.env.BUILD_COMMIT ||
		manifest.payload.retentionTier !== 'daily' ||
		manifest.payload.restoreBaseline.id !==
			input.env.TRUSTED_RESTORE_BASELINE_ID ||
		manifest.payload.restoreBaseline.sha256 !==
			input.env.TRUSTED_RESTORE_BASELINE_SHA256 ||
		manifest.payload.signing.keyId !==
			input.env.BACKUP_MANIFEST_SIGNING_KEY_ID ||
		manifest.payload.sql.objectKey !==
			objectKeyForPayload(input.payload, manifest.payload.export.bookmark)
	) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-provenance-mismatch',
			'pre-drop backup manifest provenance does not match the approved request',
		)
	}
	if (!(await verifyBackupManifestSignature(input.env, manifest))) {
		throw new BackupError(
			'mailbox-pre-drop-manifest-signature-invalid',
			'pre-drop backup manifest signature verification failed',
		)
	}
	await verifyStoredObjectMatches(
		input.env.BACKUP_BUCKET,
		manifest.payload.sql.objectKey,
		{
			bytes: manifest.payload.sql.bytes,
			sha256: manifest.payload.sql.sha256,
			r2Etag: manifest.payload.sql.r2Etag,
			alreadyExisted: true,
		},
	)
	return {
		manifest,
		manifestSignatureSha256: await signatureSha256(manifest),
	}
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

function snapshotMatchesSql(snapshot: MailboxPreDropSnapshot): string {
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

export async function upsertMailboxPreDropApproval(input: {
	env: BackupEnvironment
	payload: MailboxPreDropRuntimePayload
	snapshot: MailboxPreDropSnapshot
	manifest: BackupManifest
	manifestSignatureSha256: string
	verifiedAt: string
	options?: ApiOptions
}): Promise<MailboxPreDropApprovalReceipt> {
	const expiresAt = new Date(
		Date.parse(input.verifiedAt) + 2 * 60 * 60 * 1_000,
	).toISOString()
	const payload = input.manifest.payload
	const receipt: MailboxPreDropApprovalReceipt = {
		...input.snapshot,
		requestId: input.payload.requestId,
		nonce: input.payload.nonce,
		manifestKey: input.payload.manifestKey,
		sqlObjectKey: payload.sql.objectKey,
		sqlSha256: payload.sql.sha256,
		sqlBytes: payload.sql.bytes,
		r2Etag: payload.sql.r2Etag,
		manifestKeyId: payload.signing.keyId,
		manifestSignatureSha256: input.manifestSignatureSha256,
		verifiedAt: input.verifiedAt,
		expiresAt,
		issuedBy: 'backup-control-plane',
		sourceAccountId: payload.source.accountId,
		sourceDatabaseId: payload.source.databaseId,
		sourceDatabaseName: payload.source.databaseName,
		exportBookmark: payload.export.bookmark,
		exportScheduledAt: payload.export.scheduledAt,
		exportStartedAt: payload.export.startedAt,
		exportCompletedAt: payload.export.completedAt,
		buildCommit: payload.buildCommit,
		retentionTier: payload.retentionTier,
		restoreBaselineId: payload.restoreBaseline.id,
		restoreBaselineSha256: payload.restoreBaseline.sha256,
		signatureAlgorithm: payload.signing.algorithm,
	}
	const columns = [
		'singleton',
		'request_id',
		'nonce',
		'authority_frozen_at',
		'authority_owner_count',
		'manifest_key',
		'sql_object_key',
		'sql_sha256',
		'sql_bytes',
		'r2_etag',
		'manifest_key_id',
		'manifest_signature_sha256',
		'verified_at',
		'expires_at',
		'owner_count',
		'thread_count',
		'message_count',
		'attachment_count',
		'event_count',
		'issued_by',
		'source_account_id',
		'source_database_id',
		'source_database_name',
		'export_bookmark',
		'export_scheduled_at',
		'export_started_at',
		'export_completed_at',
		'build_commit',
		'retention_tier',
		'restore_baseline_id',
		'restore_baseline_sha256',
		'signature_algorithm',
	] as const
	const values: Array<string | number> = [
		1,
		receipt.requestId,
		receipt.nonce,
		receipt.authorityFrozenAt,
		receipt.authorityOwnerCount,
		receipt.manifestKey,
		receipt.sqlObjectKey,
		receipt.sqlSha256,
		receipt.sqlBytes,
		receipt.r2Etag,
		receipt.manifestKeyId,
		receipt.manifestSignatureSha256,
		receipt.verifiedAt,
		receipt.expiresAt,
		receipt.ownerCount,
		receipt.threadCount,
		receipt.messageCount,
		receipt.attachmentCount,
		receipt.eventCount,
		receipt.issuedBy,
		receipt.sourceAccountId,
		receipt.sourceDatabaseId,
		receipt.sourceDatabaseName,
		receipt.exportBookmark,
		receipt.exportScheduledAt,
		receipt.exportStartedAt,
		receipt.exportCompletedAt,
		receipt.buildCommit,
		receipt.retentionTier,
		receipt.restoreBaselineId,
		receipt.restoreBaselineSha256,
		receipt.signatureAlgorithm,
	]
	const assignments = columns
		.filter((column) => column !== 'singleton')
		.map((column) => `${column} = excluded.${column}`)
		.join(',\n\t')
	const sqlValues = values
		.map((value) =>
			typeof value === 'number' ? String(value) : sqlLiteral(value),
		)
		.join(', ')
	const sql = `${snapshotCtes}
INSERT INTO email_user_graph_drop_approval (${columns.join(', ')})
SELECT ${sqlValues}
FROM current_snapshot
WHERE ${snapshotMatchesSql(input.snapshot)}
ON CONFLICT(singleton) DO UPDATE SET
	${assignments}
RETURNING singleton, request_id, manifest_key, sql_sha256,
	manifest_signature_sha256, verified_at, expires_at`
	const rows = await queryD1Database({
		accountId: input.env.SOURCE_ACCOUNT_ID,
		databaseId: input.env.SOURCE_DATABASE_ID,
		token: input.env.CLOUDFLARE_API_TOKEN,
		sql,
		options: input.options,
	})
	const row = rows[0]
	if (
		rows.length !== 1 ||
		row?.singleton !== 1 ||
		row.request_id !== receipt.requestId ||
		row.manifest_key !== receipt.manifestKey ||
		row.sql_sha256 !== receipt.sqlSha256 ||
		row.manifest_signature_sha256 !== receipt.manifestSignatureSha256 ||
		row.verified_at !== receipt.verifiedAt ||
		row.expires_at !== receipt.expiresAt
	) {
		throw new BackupError(
			'mailbox-pre-drop-approval-write-failed',
			'atomic pre-drop approval UPSERT was rejected or not confirmed',
		)
	}
	return receipt
}
