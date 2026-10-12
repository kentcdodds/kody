import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * A personal (signup) organization is the org whose id is a live person's
 * `users.stable_user_id`. That is the personal-owner relation: the org is that
 * person's account identity.
 *
 * Do not use founding membership (`org_id = user_id`) alone. Migration 0099
 * soft-deletes that row for former platform orgs (for example `@kody`) and
 * deletes the platform `users` row, but leaves the soft-deleted membership.
 * Counting that membership would hide team identity editing on ordinary orgs
 * that used to be platform accounts.
 */
export async function isPersonalOrg(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS ok
			 FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ ok: number }>()
	return Boolean(row)
}
