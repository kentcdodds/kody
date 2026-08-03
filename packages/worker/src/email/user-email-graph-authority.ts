import { systemEmailOwnerId } from './email-owner.ts'

export type UserEmailGraphAuthorityMarker = {
	ownerCount: number
	frozenAt: string
	droppedAt: string | null
}

export async function loadUserEmailGraphAuthorityMarker(
	db: D1Database,
): Promise<UserEmailGraphAuthorityMarker | null> {
	const row = await db
		.prepare(
			`SELECT *
			FROM email_user_graph_authority
			WHERE singleton = 1
			LIMIT 1`,
		)
		.first<{
			owner_count: number
			frozen_at: string
			dropped_at?: string | null
		}>()
	if (!row) return null
	return {
		ownerCount: Number(row.owner_count),
		frozenAt: row.frozen_at,
		droppedAt: row.dropped_at ?? null,
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
