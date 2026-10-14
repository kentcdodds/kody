export const packageSecurityAuditVerdicts = ['pass', 'concerns'] as const

export type PackageSecurityAuditVerdict =
	(typeof packageSecurityAuditVerdicts)[number]

export type PackageSecurityAuditRecord = {
	id: string
	packageId: string
	ownerUserId: string
	publishedCommit: string
	fingerprint: string
	verdict: PackageSecurityAuditVerdict
	summary: string
	auditorLabel: string | null
	recordedByUserId: string
	recordedAt: string
	createdAt: string
}

function parseVerdict(value: unknown): PackageSecurityAuditVerdict {
	return value === 'pass' ? 'pass' : 'concerns'
}

function mapRow(row: Record<string, unknown>): PackageSecurityAuditRecord {
	const auditorLabel = row['auditor_label']
	return {
		id: String(row['id']),
		packageId: String(row['package_id']),
		ownerUserId: String(row['owner_user_id']),
		publishedCommit: String(row['published_commit']),
		fingerprint: String(row['fingerprint']),
		verdict: parseVerdict(row['verdict']),
		summary: String(row['summary']),
		auditorLabel:
			typeof auditorLabel === 'string' && auditorLabel.length > 0
				? auditorLabel
				: null,
		recordedByUserId: String(row['recorded_by_user_id']),
		recordedAt: String(row['recorded_at']),
		createdAt: String(row['created_at']),
	}
}

export async function insertPackageSecurityAudit(
	db: D1Database,
	record: Omit<PackageSecurityAuditRecord, 'createdAt'>,
): Promise<PackageSecurityAuditRecord> {
	const createdAt = record.recordedAt
	await db
		.prepare(
			`INSERT INTO package_security_audits (
				id, package_id, owner_user_id, published_commit, fingerprint,
				verdict, summary, auditor_label, recorded_by_user_id,
				recorded_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			record.id,
			record.packageId,
			record.ownerUserId,
			record.publishedCommit,
			record.fingerprint,
			record.verdict,
			record.summary,
			record.auditorLabel,
			record.recordedByUserId,
			record.recordedAt,
			createdAt,
		)
		.run()
	return { ...record, createdAt }
}

export async function getLatestPackageSecurityAudit(
	db: D1Database,
	input: {
		packageId: string
		ownerUserId: string
		publishedCommit: string
		fingerprint: string
	},
): Promise<PackageSecurityAuditRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, package_id, owner_user_id, published_commit, fingerprint,
				verdict, summary, auditor_label, recorded_by_user_id,
				recorded_at, created_at
			FROM package_security_audits
			WHERE package_id = ? AND owner_user_id = ?
				AND published_commit = ? AND fingerprint = ?
			ORDER BY recorded_at DESC
			LIMIT 1`,
		)
		.bind(
			input.packageId,
			input.ownerUserId,
			input.publishedCommit,
			input.fingerprint,
		)
		.first()
	return row ? mapRow(row) : null
}
