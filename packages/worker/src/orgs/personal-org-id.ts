import {
	mintPersonId,
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Personal org id recorded on a `users` row.
 *
 * Prefer the column when present and non-empty. Blank rows fall back to the
 * equal-id brand for fixtures that still omit the column; production live rows
 * are asserted non-blank by migration 0146.
 */
export function personalOrgIdFromUserRow(row: {
	personal_org_id?: string | null
	stable_user_id: string
}): OwnerId {
	const stored = row.personal_org_id?.trim() ?? ''
	if (stored !== '') return ownerIdFromStored(stored)
	return personalOrgId(personIdFromStored(row.stable_user_id))
}

/**
 * Personal org for an authenticated person. Prefer a stamped
 * `personalOrgId` loaded from `users.personal_org_id`; fall back to the
 * equal-id brand only when the stamp is absent (fixtures / pre-stamp callers).
 * Production auth always stamps the column.
 */
export function personalOrgIdForPerson(user: {
	userId: PersonId
	personalOrgId?: OwnerId | null
}): OwnerId {
	const stamped = user.personalOrgId
	if (typeof stamped === 'string' && stamped.trim() !== '') {
		return ownerIdFromStored(stamped as string)
	}
	return personalOrgId(user.userId)
}

/**
 * Resolve personal org id when only a person id and DB are available (no
 * stamped `personalOrgId` on the caller). Prefer this over branding the
 * person id for org-keyed storage lookups.
 */
export async function loadPersonalOrgIdForPerson(
	db: D1Database,
	personId: PersonId,
): Promise<OwnerId> {
	const row = await db
		.prepare(
			`SELECT personal_org_id, stable_user_id FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(personId)
		.first<{ personal_org_id: string | null; stable_user_id: string }>()
	if (!row) {
		// Equal-id fixtures that provision an org without a users row still key
		// storage at the person id. Production always has a live users row.
		return personalOrgId(personId)
	}
	return personalOrgIdFromUserRow(row)
}

/** Mint a fresh owner id for a new personal (or team) org row. */
export function mintOwnerId(): OwnerId {
	return ownerIdFromStored(mintPersonId() as string)
}
