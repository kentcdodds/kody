/**
 * soft-delete-read-filter: opt-out
 *
 * Signup orgs are identified by a founding membership with org_id = user_id.
 * That row may be soft-deleted after another owner joins; we must still treat
 * the org as personal, so this read intentionally includes deleted_at rows.
 */

/**
 * Signup organizations use the founding person's stable id as the org id
 * (`org_id = user_id` on the founding membership). That identity survives
 * soft-deleting the founding row — include deleted memberships so another
 * owner cannot rename or soft-delete a signup org from org settings.
 */
export async function isPersonalOrg(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS ok
			 FROM org_memberships
			 WHERE org_id = ?
			   AND user_id = ?`,
		)
		.bind(orgId, orgId)
		.first<{ ok: number }>()
	return Boolean(row)
}
