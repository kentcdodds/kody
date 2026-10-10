import { listGrants, type GrantView } from '#worker/orgs/access-writes.ts'

export type ListedOutsideCollaborator = {
	userId: string
	username: string | null
	displayName: string | null
	avatarKey: string | null
	grants: Array<GrantView>
}

/**
 * People who hold a live user grant on this organization but have no live
 * membership — outside collaborators. Team-mediated access alone does not
 * list them here; those people still need a direct user grant or membership.
 */
export async function listOutsideCollaborators(
	db: D1Database,
	orgId: string,
): Promise<Array<ListedOutsideCollaborator>> {
	const grants = await listGrants({
		db,
		orgId,
		subjectType: 'user',
	})
	if (grants.length === 0) return []

	const byUser = new Map<string, Array<GrantView>>()
	for (const grant of grants) {
		const existing = byUser.get(grant.subjectId)
		if (existing) existing.push(grant)
		else byUser.set(grant.subjectId, [grant])
	}

	const userIds = [...byUser.keys()]
	const members = await db
		.prepare(
			`SELECT user_id FROM org_memberships
			 WHERE org_id = ?
			   AND deleted_at IS NULL
			   AND user_id IN (${userIds.map(() => '?').join(', ')})`,
		)
		.bind(orgId, ...userIds)
		.all<{ user_id: string }>()
	const memberIds = new Set((members.results ?? []).map((row) => row.user_id))

	const collaboratorIds = userIds.filter((id) => !memberIds.has(id))
	if (collaboratorIds.length === 0) return []

	const people = await db
		.prepare(
			`SELECT stable_user_id AS user_id,
			        username,
			        display_name,
			        avatar_key
			 FROM users
			 WHERE deleted_at IS NULL
			   AND stable_user_id IN (${collaboratorIds.map(() => '?').join(', ')})`,
		)
		.bind(...collaboratorIds)
		.all<{
			user_id: string
			username: string | null
			display_name: string | null
			avatar_key: string | null
		}>()
	const identity = new Map(
		(people.results ?? []).map((row) => [row.user_id, row]),
	)

	return collaboratorIds
		.map((userId) => {
			const person = identity.get(userId)
			return {
				userId,
				username: person?.username ?? null,
				displayName: person?.display_name ?? null,
				avatarKey: person?.avatar_key ?? null,
				grants: byUser.get(userId) ?? [],
			}
		})
		.sort((left, right) => {
			const leftKey = left.username ?? left.userId
			const rightKey = right.username ?? right.userId
			return leftKey.localeCompare(rightKey)
		})
}
