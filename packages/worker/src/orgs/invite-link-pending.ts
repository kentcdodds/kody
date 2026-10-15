/**
 * Invite links a signed-in person opened but has not accepted or declined.
 * They wait on the person's Organizations page next to addressed invites.
 */
import { andActiveOrgSql } from '#worker/soft-delete/live-sql.ts'
import {
	linkColumns,
	rowDomainsBlocked,
	rowTarget,
	rowToStored,
	type InviteLinkRow,
	type InviteLinkTarget,
	type StoredInviteLink,
} from './invite-links.ts'

/**
 * Remember that a signed-in person opened a link so it waits on their
 * Organizations page until they accept or decline.
 */
export async function recordInviteLinkPending(input: {
	db: D1Database
	linkId: string
	userId: string
}) {
	await input.db
		.prepare(
			`INSERT OR IGNORE INTO org_invite_link_pending (link_id, user_id, created_at)
			 VALUES (?, ?, ?)`,
		)
		.bind(input.linkId, input.userId, new Date().toISOString())
		.run()
}

export async function clearInviteLinkPending(input: {
	db: D1Database
	linkId: string
	userId: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM org_invite_link_pending WHERE link_id = ? AND user_id = ?`,
		)
		.bind(input.linkId, input.userId)
		.run()
	return (result.meta?.changes ?? 0) > 0
}

/** The link behind one of this person's pending rows, or null. */
export async function getPendingInviteLinkForPerson(input: {
	db: D1Database
	linkId: string
	userId: string
}): Promise<StoredInviteLink | null> {
	const row = await input.db
		.prepare(
			`SELECT ${linkColumns('l')}
			 FROM org_invite_link_pending p
			 INNER JOIN org_invite_links l ON l.id = p.link_id
			 WHERE p.link_id = ? AND p.user_id = ?`,
		)
		.bind(input.linkId, input.userId)
		.first<InviteLinkRow>()
	if (!row || rowDomainsBlocked(row) || !rowTarget(row)) return null
	return rowToStored(row)
}

export type PendingInviteLinkSummary = {
	linkId: string
	orgSlug: string
	orgDisplayName: string | null
	orgPersonal: boolean
	target: InviteLinkTarget
	teamName: string | null
	packageName: string | null
	packageKodyId: string | null
	expiresAt: string
}

/**
 * Links this person opened and has not accepted or declined, while the link
 * can still be used. Rows for links that stopped working are skipped.
 */
export async function listPendingInviteLinksForPerson(
	db: D1Database,
	input: { userId: string; now: string },
): Promise<Array<PendingInviteLinkSummary>> {
	const rows = await db
		.prepare(
			`SELECT l.id AS id, l.kind AS kind, l.role AS role, l.team_id AS team_id,
			        l.resource_type AS resource_type, l.resource_id AS resource_id,
			        l.preset AS preset, l.expires_at AS expires_at,
			        o.slug AS org_slug, o.display_name AS org_display_name,
			        EXISTS (
			          SELECT 1 FROM users owner
			          WHERE COALESCE(NULLIF(TRIM(owner.personal_org_id), ''), owner.stable_user_id) = o.id
			            AND owner.deleted_at IS NULL
			        ) AS org_personal,
			        t.name AS team_name,
			        sp.name AS package_name, sp.kody_id AS package_kody_id
			 FROM org_invite_link_pending p
			 INNER JOIN org_invite_links l ON l.id = p.link_id
			 INNER JOIN orgs o ON o.id = l.org_id
			 LEFT JOIN teams t
			   ON l.kind = 'team' AND t.id = l.team_id AND t.org_id = l.org_id
			  AND t.deleted_at IS NULL
			 LEFT JOIN saved_packages sp
			   ON l.kind = 'resource' AND sp.id = l.resource_id
			  AND sp.user_id = l.org_id AND sp.deleted_at IS NULL
			 WHERE p.user_id = ?
			   AND l.status = 'active'
			   AND l.expires_at > ?
			   AND (l.max_uses IS NULL OR l.use_count < l.max_uses)${andActiveOrgSql('o')}
			 ORDER BY p.created_at DESC`,
		)
		.bind(input.userId, input.now)
		.all<
			Pick<
				InviteLinkRow,
				| 'id'
				| 'kind'
				| 'role'
				| 'team_id'
				| 'resource_type'
				| 'resource_id'
				| 'preset'
				| 'expires_at'
			> & {
				org_slug: string
				org_display_name: string | null
				org_personal: number | null
				team_name: string | null
				package_name: string | null
				package_kody_id: string | null
			}
		>()
	return (rows.results ?? []).flatMap((row) => {
		const target = rowTarget(row)
		if (!target) return []
		if (target.kind === 'team' && !row.team_name) return []
		if (target.kind === 'resource' && !row.package_name) return []
		return [
			{
				linkId: row.id,
				orgSlug: row.org_slug,
				orgDisplayName: row.org_display_name,
				orgPersonal: row.org_personal === 1,
				target,
				teamName: row.team_name,
				packageName: row.package_name,
				packageKodyId: row.package_kody_id,
				expiresAt: row.expires_at,
			},
		]
	})
}
