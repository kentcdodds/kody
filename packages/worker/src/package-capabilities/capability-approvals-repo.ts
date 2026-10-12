export type PackageCapabilityApprovalRow = {
	id: string
	package_id: string
	owner_user_id: string
	published_commit: string
	fingerprint: string
	capability_set_json: string
	dependency_snapshot_json: string
	approved_by_user_id: string
	approved_at: string
	created_at: string
}

export type PackageCapabilityApprovalRecord = {
	id: string
	packageId: string
	ownerUserId: string
	publishedCommit: string
	fingerprint: string
	capabilitySetJson: string
	dependencySnapshotJson: string
	approvedByUserId: string
	approvedAt: string
	createdAt: string
}

function mapRow(row: Record<string, unknown>): PackageCapabilityApprovalRecord {
	return {
		id: String(row['id']),
		packageId: String(row['package_id']),
		ownerUserId: String(row['owner_user_id']),
		publishedCommit: String(row['published_commit']),
		fingerprint: String(row['fingerprint']),
		capabilitySetJson: String(row['capability_set_json']),
		dependencySnapshotJson: String(row['dependency_snapshot_json'] ?? '{}'),
		approvedByUserId: String(row['approved_by_user_id']),
		approvedAt: String(row['approved_at']),
		createdAt: String(row['created_at']),
	}
}

export async function insertPackageCapabilityApproval(
	db: D1Database,
	row: Omit<PackageCapabilityApprovalRow, 'created_at'> & {
		created_at?: string
	},
): Promise<PackageCapabilityApprovalRecord> {
	const createdAt = row.created_at ?? row.approved_at
	await db
		.prepare(
			`INSERT INTO package_capability_approvals (
				id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.package_id,
			row.owner_user_id,
			row.published_commit,
			row.fingerprint,
			row.capability_set_json,
			row.dependency_snapshot_json,
			row.approved_by_user_id,
			row.approved_at,
			createdAt,
		)
		.run()
	return mapRow({ ...row, created_at: createdAt })
}

export async function getLatestPackageCapabilityApproval(
	db: D1Database,
	input: { packageId: string; ownerUserId: string },
): Promise<PackageCapabilityApprovalRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			FROM package_capability_approvals
			WHERE package_id = ? AND owner_user_id = ?
			ORDER BY approved_at DESC
			LIMIT 1`,
		)
		.bind(input.packageId, input.ownerUserId)
		.first()
	return row ? mapRow(row) : null
}

export async function findPackageCapabilityApprovalByFingerprint(
	db: D1Database,
	input: {
		packageId: string
		ownerUserId: string
		fingerprint: string
	},
): Promise<PackageCapabilityApprovalRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			FROM package_capability_approvals
			WHERE package_id = ? AND owner_user_id = ? AND fingerprint = ?
			ORDER BY approved_at DESC
			LIMIT 1`,
		)
		.bind(input.packageId, input.ownerUserId, input.fingerprint)
		.first()
	return row ? mapRow(row) : null
}
