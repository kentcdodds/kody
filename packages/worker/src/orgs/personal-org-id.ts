import {
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Personal org id recorded on a `users` row.
 *
 * Phase 1 (#3053) adds `users.personal_org_id`, backfills it to
 * `stable_user_id`, and dual-writes that same value. Prefer the column when
 * it is present and non-empty so a widened row and an older row (column
 * null or blank) both resolve. Phase 2 switches readers to this helper and
 * to `request.org.id`, and new signups start minting `orgs.id` distinct from
 * the person id. `personalOrgId(person)` stays the identity cast until phase 3.
 */
export function personalOrgIdFromUserRow(row: {
	personal_org_id?: string | null
	stable_user_id: string
}): OwnerId {
	const stored = row.personal_org_id?.trim() ?? ''
	if (stored !== '') return ownerIdFromStored(stored)
	return personalOrgId(personIdFromStored(row.stable_user_id))
}
