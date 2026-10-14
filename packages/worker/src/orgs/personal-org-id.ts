import {
	mintPersonId,
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Personal org id recorded on a `users` row.
 *
 * Prefer the column when present and non-empty so a widened row and an older
 * row (column null or blank) both resolve. Phase 2 new signups mint
 * `orgs.id` distinct from the person id and store it here. `personalOrgId(person)`
 * stays the identity cast until phase 3.
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
 * identity cast for callers that have not loaded the column yet.
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

/** Mint a fresh owner id for a new personal (or team) org row. */
export function mintOwnerId(): OwnerId {
	return ownerIdFromStored(mintPersonId() as string)
}
