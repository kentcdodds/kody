import { listGrants, type GrantView } from '#worker/orgs/access-writes.ts'

export type ListedOrgGrant = {
	id: string
	resourceType: string
	resourceId: string
	resourceLabel: string
	subjectType: 'user' | 'team'
	subjectId: string
	subjectLabel: string
	preset: string | null
	presetLabel: string | null
	permissions: Array<string>
	createdAt: string
}

function presetLabel(preset: string | null) {
	if (!preset) return null
	switch (preset) {
		case 'use':
			return 'Use'
		case 'contribute':
			return 'Contribute'
		case 'manage':
			return 'Manage'
		default:
			return preset
	}
}

/**
 * Grants for an organization with display labels for subjects and common
 * resources (packages by kody id / name).
 */
export async function listOrgGrantsForView(
	db: D1Database,
	orgId: string,
): Promise<Array<ListedOrgGrant>> {
	const grants = await listGrants({ db, orgId })
	if (grants.length === 0) return []

	const userIds = [
		...new Set(
			grants
				.filter((grant) => grant.subjectType === 'user')
				.map((grant) => grant.subjectId),
		),
	]
	const teamIds = [
		...new Set(
			grants
				.filter((grant) => grant.subjectType === 'team')
				.map((grant) => grant.subjectId),
		),
	]
	const packageIds = [
		...new Set(
			grants
				.filter((grant) => grant.resourceType === 'package')
				.map((grant) => grant.resourceId),
		),
	]

	const [users, teams, packages] = await Promise.all([
		userIds.length === 0
			? Promise.resolve(
					[] as Array<{
						user_id: string
						username: string | null
						display_name: string | null
					}>,
				)
			: db
					.prepare(
						`SELECT stable_user_id AS user_id, username, display_name
						 FROM users
						 WHERE deleted_at IS NULL
						   AND stable_user_id IN (${userIds.map(() => '?').join(', ')})`,
					)
					.bind(...userIds)
					.all<{
						user_id: string
						username: string | null
						display_name: string | null
					}>()
					.then((result) => result.results ?? []),
		teamIds.length === 0
			? Promise.resolve(
					[] as Array<{
						id: string
						slug: string
						name: string
					}>,
				)
			: db
					.prepare(
						`SELECT id, slug, name FROM teams
						 WHERE org_id = ?
						   AND deleted_at IS NULL
						   AND id IN (${teamIds.map(() => '?').join(', ')})`,
					)
					.bind(orgId, ...teamIds)
					.all<{ id: string; slug: string; name: string }>()
					.then((result) => result.results ?? []),
		packageIds.length === 0
			? Promise.resolve(
					[] as Array<{
						id: string
						name: string | null
						kody_id: string | null
					}>,
				)
			: db
					.prepare(
						`SELECT id, name, kody_id FROM saved_packages
						 WHERE id IN (${packageIds.map(() => '?').join(', ')})`,
					)
					.bind(...packageIds)
					.all<{
						id: string
						name: string | null
						kody_id: string | null
					}>()
					.then((result) => result.results ?? []),
	])

	const userById = new Map(users.map((row) => [row.user_id, row]))
	const teamById = new Map(teams.map((row) => [row.id, row]))
	const packageById = new Map(packages.map((row) => [row.id, row]))

	return grants.map((grant) =>
		toOrgGrantView(grant, userById, teamById, packageById),
	)
}

function toOrgGrantView(
	grant: GrantView,
	userById: Map<
		string,
		{ user_id: string; username: string | null; display_name: string | null }
	>,
	teamById: Map<string, { id: string; slug: string; name: string }>,
	packageById: Map<
		string,
		{ id: string; name: string | null; kody_id: string | null }
	>,
): ListedOrgGrant {
	let subjectLabel = grant.subjectId
	if (grant.subjectType === 'user') {
		const user = userById.get(grant.subjectId)
		subjectLabel = user?.username
			? `@${user.username}`
			: user?.display_name?.trim() || grant.subjectId
	} else {
		const team = teamById.get(grant.subjectId)
		subjectLabel = team ? `${team.name} (@${team.slug})` : grant.subjectId
	}

	let resourceLabel = `${grant.resourceType}:${grant.resourceId}`
	if (grant.resourceType === 'package') {
		const pkg = packageById.get(grant.resourceId)
		if (pkg?.kody_id) resourceLabel = pkg.name?.trim() || pkg.kody_id
		else if (pkg?.name?.trim()) resourceLabel = pkg.name.trim()
	} else if (grant.resourceType === 'org') {
		resourceLabel = 'Organization'
	}

	return {
		id: grant.id,
		resourceType: grant.resourceType,
		resourceId: grant.resourceId,
		resourceLabel,
		subjectType: grant.subjectType,
		subjectId: grant.subjectId,
		subjectLabel,
		preset: grant.preset,
		presetLabel: presetLabel(grant.preset),
		permissions: grant.permissions,
		createdAt: grant.createdAt,
	}
}
