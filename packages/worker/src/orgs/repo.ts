import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OrgRole,
	type RequestOrg,
} from '@kody-internal/shared/request-context.ts'

export type OrgRecord = {
	id: string
	slug: string
	display_name: string | null
	plan: string
	entitlement_ladder: string
}

export type OrgBinding = {
	org: RequestOrg
	/** Null for outside collaborators who hold a live grant but no membership. */
	role: OrgRole | null
}

export type PersonOrg = OrgRecord & {
	role: OrgRole | null
}

const orgSelect = `id, slug, display_name, plan, entitlement_ladder`

export async function getOrgById(db: D1Database, orgId: string) {
	return await db
		.prepare(
			`SELECT ${orgSelect}
			 FROM orgs WHERE id = ?`,
		)
		.bind(orgId)
		.first<OrgRecord>()
}

export async function getOrgBySlug(db: D1Database, slug: string) {
	const normalized = slug.trim().toLowerCase()
	if (!normalized) return null
	return await db
		.prepare(
			`SELECT ${orgSelect}
			 FROM orgs WHERE slug = ?`,
		)
		.bind(normalized)
		.first<OrgRecord>()
}

export async function getLiveOwnerMembership(
	db: D1Database,
	orgId: string,
	userId: string,
) {
	return await db
		.prepare(
			`SELECT org_id, user_id, role
			 FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ org_id: string; user_id: string; role: OrgRole }>()
}

function toBinding(row: {
	org_id: string
	org_slug: string | null
	role: OrgRole | null
}): OrgBinding {
	return {
		org: {
			id: ownerIdFromStored(row.org_id),
			slug: row.org_slug?.trim() || null,
		},
		role: row.role,
	}
}

/**
 * The person's personal org (id = stable user id). Falls back to
 * personalOrgId when the membership row is missing so session/SSR tests
 * and unmigrated fixtures keep working. P9 can require the row.
 */
export async function loadOrgBindingForPerson(
	db: D1Database,
	personId: string,
): Promise<OrgBinding> {
	const row = await db
		.prepare(
			`SELECT o.id AS org_id, o.slug AS org_slug, m.role AS role
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.org_id = m.user_id
			   AND m.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(personId)
		.first<{ org_id: string; org_slug: string; role: OrgRole }>()
	if (!row) {
		const person = personIdFromStored(personId)
		return {
			org: { id: personalOrgId(person), slug: null },
			role: 'owner',
		}
	}
	return toBinding(row)
}

/**
 * Bind a person to a specific org: live membership, or any live grant in that
 * org (outside collaborator, role null). Returns null when neither applies.
 */
export async function loadOrgBindingForOrg(
	db: D1Database,
	personId: string,
	orgId: string,
): Promise<OrgBinding | null> {
	const membership = await db
		.prepare(
			`SELECT o.id AS org_id, o.slug AS org_slug, m.role AS role
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.org_id = ?
			   AND m.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(personId, orgId)
		.first<{ org_id: string; org_slug: string; role: OrgRole }>()
	if (membership) return toBinding(membership)

	const grant = await db
		.prepare(
			`SELECT o.id AS org_id, o.slug AS org_slug
			 FROM grants g
			 INNER JOIN orgs o ON o.id = g.org_id
			 WHERE g.org_id = ?
			   AND g.subject_type = 'user'
			   AND g.subject_id = ?
			   AND g.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(orgId, personId)
		.first<{ org_id: string; org_slug: string }>()
	if (!grant) return null
	return toBinding({ ...grant, role: null })
}

/**
 * Orgs the person can pick: live memberships union orgs where they hold a
 * live grant. Grant-only rows have `role: null`.
 */
export async function listOrgsForPerson(
	db: D1Database,
	personId: string,
): Promise<Array<PersonOrg>> {
	const rows = await db
		.prepare(
			`SELECT o.id, o.slug, o.display_name, o.plan, o.entitlement_ladder,
			        m.role AS role
			 FROM orgs o
			 LEFT JOIN org_memberships m
			   ON m.org_id = o.id
			  AND m.user_id = ?
			  AND m.deleted_at IS NULL
			 WHERE m.user_id IS NOT NULL
			    OR EXISTS (
			      SELECT 1 FROM grants g
			      WHERE g.org_id = o.id
			        AND g.subject_type = 'user'
			        AND g.subject_id = ?
			        AND g.deleted_at IS NULL
			    )
			 ORDER BY o.slug ASC, o.id ASC`,
		)
		.bind(personId, personId)
		.all<OrgRecord & { role: OrgRole | null }>()
	return (rows.results ?? []).map((row) => ({
		...row,
		role: row.role ?? null,
	}))
}
