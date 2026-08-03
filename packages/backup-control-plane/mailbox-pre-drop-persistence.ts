import {
	assertMailboxPreDropApprovalCanonicalRelation,
	mailboxPreDropApprovalColumns,
	mailboxPreDropApprovalRow,
	mailboxPreDropApprovalTable,
	type MailboxPreDropApprovalRow,
} from '@kody-internal/shared/mailbox-pre-drop-approval.ts'
import { type BackupManifest } from '@kody-internal/shared/backup-manifest.ts'

import { queryD1Database } from './d1-import-api.ts'
import { type ApiOptions } from './d1-export-api.ts'
import { BackupError } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropApprovalReceipt,
	type MailboxPreDropRuntimePayload,
	type MailboxPreDropSnapshot,
} from './backup-types.ts'
import {
	mailboxPreDropSnapshotCtes,
	mailboxPreDropSnapshotMatchesSql,
} from './mailbox-pre-drop-snapshot.ts'

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

function sqlValue(value: string | number): string {
	return typeof value === 'number' ? String(value) : sqlLiteral(value)
}

function exactReplaySql(): string {
	return mailboxPreDropApprovalColumns
		.filter((column) => column !== 'singleton')
		.map(
			(column) =>
				`${mailboxPreDropApprovalTable}.${column} = excluded.${column}`,
		)
		.join('\n\t\tAND ')
}

function rowMatches(
	actual: Record<string, unknown>,
	expected: MailboxPreDropApprovalRow,
): boolean {
	return mailboxPreDropApprovalColumns.every(
		(column) => actual[column] === expected[column],
	)
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
		retentionTier: 'daily',
		restoreBaselineId: payload.restoreBaseline.id,
		restoreBaselineSha256: payload.restoreBaseline.sha256,
		signatureAlgorithm: payload.signing.algorithm,
	}
	const approvalRow = mailboxPreDropApprovalRow(receipt)
	assertMailboxPreDropApprovalCanonicalRelation(approvalRow)
	const assignments = mailboxPreDropApprovalColumns
		.filter((column) => column !== 'singleton')
		.map((column) => `${column} = excluded.${column}`)
		.join(',\n\t')
	const values = mailboxPreDropApprovalColumns
		.map((column) => sqlValue(approvalRow[column]))
		.join(', ')
	const sql = `${mailboxPreDropSnapshotCtes}
INSERT INTO ${mailboxPreDropApprovalTable} (${mailboxPreDropApprovalColumns.join(', ')})
SELECT ${values}
FROM current_snapshot
WHERE ${mailboxPreDropSnapshotMatchesSql(input.snapshot)}
ON CONFLICT(singleton) DO UPDATE SET
	${assignments}
WHERE excluded.verified_at > ${mailboxPreDropApprovalTable}.verified_at
	OR (
		excluded.verified_at = ${mailboxPreDropApprovalTable}.verified_at
		AND ${exactReplaySql()}
	)
RETURNING ${mailboxPreDropApprovalColumns.join(', ')}`
	const rows = await queryD1Database({
		accountId: input.env.SOURCE_ACCOUNT_ID,
		databaseId: input.env.SOURCE_DATABASE_ID,
		token: input.env.CLOUDFLARE_API_TOKEN,
		sql,
		options: input.options,
	})
	const row = rows[0]
	if (rows.length !== 1 || !row || !rowMatches(row, approvalRow)) {
		throw new BackupError(
			'mailbox-pre-drop-approval-write-failed',
			'atomic pre-drop approval was stale, conflicted, or not confirmed',
		)
	}
	return receipt
}
