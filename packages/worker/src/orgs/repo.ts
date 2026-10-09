import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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
	role: OrgRole
}

export async function getOrgById(db: D1Database, orgId: string) {
	return await db
		.prepare(
			`SELECT id, slug, display_name, plan, entitlement_ladder
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
			`SELECT id, slug, display_name, plan, entitlement_ladder
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

/**
 * P3: each person has one personal org whose id equals their stable user id.
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
		throw new Error(
			`Missing personal org membership for person ${personId}. Run Teams expand provisioning or migration 0089.`,
		)
	}
	return {
		org: {
			id: ownerIdFromStored(row.org_id),
			slug: row.org_slug?.trim() || null,
		},
		role: row.role,
	}
}
