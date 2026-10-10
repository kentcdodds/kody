export type ListedTeam = {
	id: string
	slug: string
	name: string
	description: string | null
	memberCount: number
}

export type ListedTeamMember = {
	userId: string
	username: string | null
	displayName: string | null
	avatarKey: string | null
}

export type ListedTeamWithMembers = ListedTeam & {
	members: Array<ListedTeamMember>
}

/**
 * Live teams for an organization, with live member counts.
 */
export async function listTeams(
	db: D1Database,
	orgId: string,
): Promise<Array<ListedTeam>> {
	const rows = await db
		.prepare(
			`SELECT t.id AS id,
			        t.slug AS slug,
			        t.name AS name,
			        t.description AS description,
			        (
			          SELECT COUNT(*)
			          FROM team_members tm
			          WHERE tm.team_id = t.id
			            AND tm.deleted_at IS NULL
			        ) AS member_count
			 FROM teams t
			 WHERE t.org_id = ?
			   AND t.deleted_at IS NULL
			 ORDER BY t.slug ASC`,
		)
		.bind(orgId)
		.all<{
			id: string
			slug: string
			name: string
			description: string | null
			member_count: number
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		memberCount: Number(row.member_count ?? 0),
	}))
}

/**
 * Live team members with public identity when the person still has a live user
 * row.
 */
export async function listTeamMembers(
	db: D1Database,
	orgId: string,
	teamId: string,
): Promise<Array<ListedTeamMember>> {
	const team = await db
		.prepare(
			`SELECT id FROM teams
			 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
		)
		.bind(teamId, orgId)
		.first<{ id: string }>()
	if (!team) return []
	const rows = await db
		.prepare(
			`SELECT tm.user_id AS user_id,
			        u.username AS username,
			        u.display_name AS display_name,
			        u.avatar_key AS avatar_key
			 FROM team_members tm
			 LEFT JOIN users u
			   ON u.stable_user_id = tm.user_id
			  AND u.deleted_at IS NULL
			 WHERE tm.team_id = ?
			   AND tm.deleted_at IS NULL
			 ORDER BY COALESCE(u.username, tm.user_id) ASC`,
		)
		.bind(teamId)
		.all<{
			user_id: string
			username: string | null
			display_name: string | null
			avatar_key: string | null
		}>()
	return (rows.results ?? []).map((row) => ({
		userId: row.user_id,
		username: row.username,
		displayName: row.display_name,
		avatarKey: row.avatar_key,
	}))
}

/**
 * Teams plus their live members in one round trip for the management page.
 */
export async function listTeamsWithMembers(
	db: D1Database,
	orgId: string,
): Promise<Array<ListedTeamWithMembers>> {
	const rows = await db
		.prepare(
			`SELECT t.id AS team_id,
			        t.slug AS team_slug,
			        t.name AS team_name,
			        t.description AS team_description,
			        tm.user_id AS user_id,
			        u.username AS username,
			        u.display_name AS display_name,
			        u.avatar_key AS avatar_key
			 FROM teams t
			 LEFT JOIN team_members tm
			   ON tm.team_id = t.id
			  AND tm.deleted_at IS NULL
			 LEFT JOIN users u
			   ON u.stable_user_id = tm.user_id
			  AND u.deleted_at IS NULL
			 WHERE t.org_id = ?
			   AND t.deleted_at IS NULL
			 ORDER BY t.slug ASC, COALESCE(u.username, tm.user_id) ASC`,
		)
		.bind(orgId)
		.all<{
			team_id: string
			team_slug: string
			team_name: string
			team_description: string | null
			user_id: string | null
			username: string | null
			display_name: string | null
			avatar_key: string | null
		}>()
	const byId = new Map<string, ListedTeamWithMembers>()
	for (const row of rows.results ?? []) {
		let team = byId.get(row.team_id)
		if (!team) {
			team = {
				id: row.team_id,
				slug: row.team_slug,
				name: row.team_name,
				description: row.team_description,
				memberCount: 0,
				members: [],
			}
			byId.set(row.team_id, team)
		}
		if (!row.user_id) continue
		team.members.push({
			userId: row.user_id,
			username: row.username,
			displayName: row.display_name,
			avatarKey: row.avatar_key,
		})
		team.memberCount = team.members.length
	}
	return [...byId.values()]
}
