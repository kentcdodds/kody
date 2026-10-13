/**
 * Org scoping for custom hostnames.
 *
 * Intentionally includes soft-deleted packages: soft-delete must not free
 * Cloudflare SaaS hostname slots while the hostname row remains, and owners
 * must still be able to list and remove those hostnames to free the abuse cap.
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

export async function listOrgCustomHostnameRows<T>(
	db: D1Database,
	orgId: string,
) {
	const rows = await db
		.prepare(
			`SELECT * FROM package_app_custom_hostnames
			 WHERE org_id = ?
			    OR package_id IN (
			      SELECT id FROM saved_packages WHERE user_id = ?
			    )
			 ORDER BY created_at ASC`,
		)
		.bind(orgId, orgId)
		.all<T>()
	return rows.results ?? []
}

/** True when the package belongs to the org, including soft-deleted packages. */
export async function orgOwnsPackageIncludingDeleted(
	db: D1Database,
	input: { orgId: string; packageId: string },
) {
	const row = await db
		.prepare(
			`SELECT id FROM saved_packages WHERE id = ? AND user_id = ? LIMIT 1`,
		)
		.bind(input.packageId, input.orgId)
		.first<{ id: string }>()
	return row != null
}
