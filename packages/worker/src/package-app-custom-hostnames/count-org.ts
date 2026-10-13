/**
 * Abuse-cap counting for custom hostnames.
 *
 * Intentionally includes soft-deleted packages: soft-delete must not free
 * Cloudflare SaaS hostname slots while the hostname row remains.
 *
 * soft-delete-read-filter: opt-out
 */

export async function countOrgCustomHostnames(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM package_app_custom_hostnames ch
			 WHERE ch.org_id = ?
			    OR ch.package_id IN (
			      SELECT id FROM saved_packages WHERE user_id = ?
			    )`,
		)
		.bind(orgId, orgId)
		.first<{ count: number }>()
	return row?.count ?? 0
}
