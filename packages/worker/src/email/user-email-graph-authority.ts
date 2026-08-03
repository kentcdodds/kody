import { systemEmailOwnerId } from './email-owner.ts'

export const userEmailGraphAuthorityMaxParityAgeHours = 6

export type UserEmailGraphAuthorityMarker = {
	ownerCount: number
	frozenAt: string
	maxParityAgeHours: number
}

export async function loadUserEmailGraphAuthorityMarker(
	db: D1Database,
): Promise<UserEmailGraphAuthorityMarker | null> {
	const row = await db
		.prepare(
			`SELECT owner_count, frozen_at, max_parity_age_hours
			FROM email_user_graph_authority
			WHERE singleton = 1
			LIMIT 1`,
		)
		.first<{
			owner_count: number
			frozen_at: string
			max_parity_age_hours: number
		}>()
	if (!row) return null
	return {
		ownerCount: Number(row.owner_count),
		frozenAt: row.frozen_at,
		maxParityAgeHours: Number(row.max_parity_age_hours),
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
	if (marker.maxParityAgeHours !== userEmailGraphAuthorityMaxParityAgeHours) {
		throw new Error(
			'USER Mailbox write rejected: email_user_graph_authority marker policy is invalid.',
		)
	}
}
