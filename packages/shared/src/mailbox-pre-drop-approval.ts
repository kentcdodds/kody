export const mailboxPreDropApprovalTable =
	'email_user_graph_drop_approval' as const

export const mailboxPreDropApprovalColumns = [
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

export type MailboxPreDropApprovalColumn =
	(typeof mailboxPreDropApprovalColumns)[number]

export type MailboxPreDropApprovalRow = {
	singleton: 1
	request_id: string
	nonce: string
	authority_frozen_at: string
	authority_owner_count: number
	manifest_key: string
	sql_object_key: string
	sql_sha256: string
	sql_bytes: number
	r2_etag: string
	manifest_key_id: string
	manifest_signature_sha256: string
	verified_at: string
	expires_at: string
	owner_count: number
	thread_count: number
	message_count: number
	attachment_count: number
	event_count: number
	issued_by: 'backup-control-plane'
	source_account_id: string
	source_database_id: string
	source_database_name: string
	export_bookmark: string
	export_scheduled_at: string
	export_started_at: string
	export_completed_at: string
	build_commit: string
	retention_tier: 'daily'
	restore_baseline_id: string
	restore_baseline_sha256: string
	signature_algorithm: 'Ed25519'
}

export type MailboxPreDropApprovalEvidence = {
	requestId: string
	nonce: string
	authorityFrozenAt: string
	authorityOwnerCount: number
	manifestKey: string
	sqlObjectKey: string
	sqlSha256: string
	sqlBytes: number
	r2Etag: string
	manifestKeyId: string
	manifestSignatureSha256: string
	verifiedAt: string
	expiresAt: string
	ownerCount: number
	threadCount: number
	messageCount: number
	attachmentCount: number
	eventCount: number
	issuedBy: 'backup-control-plane'
	sourceAccountId: string
	sourceDatabaseId: string
	sourceDatabaseName: string
	exportBookmark: string
	exportScheduledAt: string
	exportStartedAt: string
	exportCompletedAt: string
	buildCommit: string
	retentionTier: 'daily'
	restoreBaselineId: string
	restoreBaselineSha256: string
	signatureAlgorithm: 'Ed25519'
}

export const mailboxPreDropApprovalContract = {
	table: mailboxPreDropApprovalTable,
	columns: mailboxPreDropApprovalColumns,
	sqliteTypes: {
		singleton: 'INTEGER',
		request_id: 'TEXT',
		nonce: 'TEXT',
		authority_frozen_at: 'TEXT',
		authority_owner_count: 'INTEGER',
		manifest_key: 'TEXT',
		sql_object_key: 'TEXT',
		sql_sha256: 'TEXT',
		sql_bytes: 'INTEGER',
		r2_etag: 'TEXT',
		manifest_key_id: 'TEXT',
		manifest_signature_sha256: 'TEXT',
		verified_at: 'TEXT',
		expires_at: 'TEXT',
		owner_count: 'INTEGER',
		thread_count: 'INTEGER',
		message_count: 'INTEGER',
		attachment_count: 'INTEGER',
		event_count: 'INTEGER',
		issued_by: 'TEXT',
		source_account_id: 'TEXT',
		source_database_id: 'TEXT',
		source_database_name: 'TEXT',
		export_bookmark: 'TEXT',
		export_scheduled_at: 'TEXT',
		export_started_at: 'TEXT',
		export_completed_at: 'TEXT',
		build_commit: 'TEXT',
		retention_tier: 'TEXT',
		restore_baseline_id: 'TEXT',
		restore_baseline_sha256: 'TEXT',
		signature_algorithm: 'TEXT',
	} satisfies Record<MailboxPreDropApprovalColumn, 'INTEGER' | 'TEXT'>,
	provenance: {
		request: ['request_id', 'nonce'],
		frozenSnapshot: [
			'authority_frozen_at',
			'authority_owner_count',
			'owner_count',
			'thread_count',
			'message_count',
			'attachment_count',
			'event_count',
		],
		signedManifest: [
			'manifest_key',
			'sql_object_key',
			'sql_sha256',
			'sql_bytes',
			'r2_etag',
			'manifest_key_id',
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
		],
		controlPlaneVerification: [
			'manifest_signature_sha256',
			'verified_at',
			'expires_at',
			'issued_by',
		],
	},
	fixedValues: {
		singleton: 1,
		issued_by: 'backup-control-plane',
		retention_tier: 'daily',
		signature_algorithm: 'Ed25519',
	},
	maximumApprovalAgeMilliseconds: 2 * 60 * 60 * 1_000,
	canonicalRelation: {
		manifestPrefix: 'adhoc/mailbox-drop/d1/',
		manifestFilename: 'manifest.json',
		sqlFilename: 'backup-request.sql',
	},
} as const

export function mailboxPreDropObjectPrefix(input: {
	sourceDatabaseId: string
	exportScheduledAt: string
	nonce: string
	requestId: string
}): string {
	const compactTimestamp = input.exportScheduledAt.replaceAll(/[-:.]/g, '')
	return (
		`${mailboxPreDropApprovalContract.canonicalRelation.manifestPrefix}` +
		`${input.sourceDatabaseId}/${compactTimestamp}-${input.nonce}-${input.requestId}`
	)
}

export function mailboxPreDropApprovalRow(
	evidence: MailboxPreDropApprovalEvidence,
): MailboxPreDropApprovalRow {
	return {
		singleton: 1,
		request_id: evidence.requestId,
		nonce: evidence.nonce,
		authority_frozen_at: evidence.authorityFrozenAt,
		authority_owner_count: evidence.authorityOwnerCount,
		manifest_key: evidence.manifestKey,
		sql_object_key: evidence.sqlObjectKey,
		sql_sha256: evidence.sqlSha256,
		sql_bytes: evidence.sqlBytes,
		r2_etag: evidence.r2Etag,
		manifest_key_id: evidence.manifestKeyId,
		manifest_signature_sha256: evidence.manifestSignatureSha256,
		verified_at: evidence.verifiedAt,
		expires_at: evidence.expiresAt,
		owner_count: evidence.ownerCount,
		thread_count: evidence.threadCount,
		message_count: evidence.messageCount,
		attachment_count: evidence.attachmentCount,
		event_count: evidence.eventCount,
		issued_by: evidence.issuedBy,
		source_account_id: evidence.sourceAccountId,
		source_database_id: evidence.sourceDatabaseId,
		source_database_name: evidence.sourceDatabaseName,
		export_bookmark: evidence.exportBookmark,
		export_scheduled_at: evidence.exportScheduledAt,
		export_started_at: evidence.exportStartedAt,
		export_completed_at: evidence.exportCompletedAt,
		build_commit: evidence.buildCommit,
		retention_tier: evidence.retentionTier,
		restore_baseline_id: evidence.restoreBaselineId,
		restore_baseline_sha256: evidence.restoreBaselineSha256,
		signature_algorithm: evidence.signatureAlgorithm,
	}
}

export function assertMailboxPreDropApprovalCanonicalRelation(
	row: MailboxPreDropApprovalRow,
): void {
	const objectPrefix = mailboxPreDropObjectPrefix({
		sourceDatabaseId: row.source_database_id,
		exportScheduledAt: row.export_scheduled_at,
		nonce: row.nonce,
		requestId: row.request_id,
	})
	const { manifestFilename, sqlFilename } =
		mailboxPreDropApprovalContract.canonicalRelation
	const expectedManifestKey = `${objectPrefix}/${manifestFilename}`
	const expectedSqlObjectKey = `${objectPrefix}/${sqlFilename}`
	const approvalAge = Date.parse(row.expires_at) - Date.parse(row.verified_at)
	if (
		row.singleton !== mailboxPreDropApprovalContract.fixedValues.singleton ||
		row.issued_by !== mailboxPreDropApprovalContract.fixedValues.issued_by ||
		row.retention_tier !==
			mailboxPreDropApprovalContract.fixedValues.retention_tier ||
		row.signature_algorithm !==
			mailboxPreDropApprovalContract.fixedValues.signature_algorithm ||
		row.manifest_key !== expectedManifestKey ||
		row.sql_object_key !== expectedSqlObjectKey ||
		!Number.isFinite(approvalAge) ||
		approvalAge <= 0 ||
		approvalAge > mailboxPreDropApprovalContract.maximumApprovalAgeMilliseconds
	) {
		throw new Error(
			'Mailbox pre-drop approval violates its canonical relation.',
		)
	}
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

export function mailboxPreDropApprovalInsertSql(
	row: MailboxPreDropApprovalRow,
): string {
	assertMailboxPreDropApprovalCanonicalRelation(row)
	const values = mailboxPreDropApprovalColumns.map((column) => row[column])
	const literals = values.map((value) =>
		typeof value === 'number' ? String(value) : sqlLiteral(value),
	)
	return `INSERT INTO ${mailboxPreDropApprovalTable} (${mailboxPreDropApprovalColumns.join(', ')})
VALUES (${literals.join(', ')})`
}
