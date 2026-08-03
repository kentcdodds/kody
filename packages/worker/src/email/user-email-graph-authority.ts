import { systemEmailOwnerId } from './email-owner.ts'

export type UserEmailGraphAuthorityMarker = {
	ownerCount: number
	frozenAt: string
	droppedAt: string
	backupObjectKey: string
	backupSha256: string
}

export async function loadUserEmailGraphAuthorityMarker(
	db: D1Database,
): Promise<UserEmailGraphAuthorityMarker | null> {
	const row = await db
		.prepare(
			`SELECT
				owner_count, frozen_at, dropped_at, backup_object_key, backup_sha256
			FROM email_user_graph_authority
			WHERE singleton = 1
			LIMIT 1`,
		)
		.first<{
			owner_count: number
			frozen_at: string
			dropped_at: string
			backup_object_key: string
			backup_sha256: string
		}>()
	if (!row) return null
	return {
		ownerCount: Number(row.owner_count),
		frozenAt: row.frozen_at,
		droppedAt: row.dropped_at,
		backupObjectKey: row.backup_object_key,
		backupSha256: row.backup_sha256,
	}
}

export async function assertUserEmailGraphAuthority(input: {
	db: D1Database
	ownerId: string
}) {
	if (input.ownerId === systemEmailOwnerId) return
	const marker = await loadUserEmailGraphAuthorityMarker(input.db)
	if (!marker) {
		throw new Error(
			'USER Mailbox write rejected: email_user_graph_authority cutover marker is missing.',
		)
	}
}
