import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import { listGrants } from '#worker/orgs/access-writes.ts'
import { listOrgMembers } from '#worker/orgs/org-members-list.ts'
import { listTeams } from '#worker/orgs/org-teams-list.ts'
import {
	isPackageCollaboratorPreset,
	type PackageCollaboratorKind,
	type PackageCollaboratorMemberOption,
	type PackageCollaboratorTeamOption,
	type PackageCollaboratorView,
} from '#universal/package-collaborators.ts'

export type PackageCollaborators = {
	collaborators: Array<PackageCollaboratorView>
	options: {
		teams: Array<PackageCollaboratorTeamOption>
		members: Array<PackageCollaboratorMemberOption>
	}
}

type UserRow = {
	user_id: string
	username: string | null
	display_name: string | null
	avatar_key: string | null
}

function readPreset(value: string | null) {
	return value !== null && isPackageCollaboratorPreset(value) ? value : null
}

const kindOrder: Record<PackageCollaboratorKind, number> = {
	team: 0,
	member: 1,
	outside: 2,
}

async function loadUsers(db: D1Database, userIds: ReadonlyArray<string>) {
	if (userIds.length === 0) return new Map<string, UserRow>()
	const rows = await db
		.prepare(
			`SELECT stable_user_id AS user_id, username, display_name, avatar_key
			 FROM users
			 WHERE deleted_at IS NULL
			   AND stable_user_id IN (${userIds.map(() => '?').join(', ')})`,
		)
		.bind(...userIds)
		.all<UserRow>()
	return new Map((rows.results ?? []).map((row) => [row.user_id, row]))
}

/**
 * Everyone who holds a live grant on one package in its owning org (teams,
 * members, and outside collaborators) and the teams and members a manager can
 * still add. Callers authorize first.
 */
export async function listPackageCollaborators(input: {
	db: D1Database
	orgId: string
	packageId: string
}): Promise<PackageCollaborators> {
	const { db, orgId, packageId } = input
	const [grants, members, teams] = await Promise.all([
		listGrants({ db, orgId, resourceType: 'package', resourceId: packageId }),
		listOrgMembers(db, orgId),
		listTeams(db, orgId),
	])
	const memberIds = new Set(members.map((member) => member.userId))
	const teamsById = new Map(teams.map((team) => [team.id, team]))
	const users = await loadUsers(db, [
		...new Set(
			grants
				.filter((grant) => grant.subjectType === 'user')
				.map((grant) => grant.subjectId),
		),
	])

	const collaborators = grants.flatMap(
		(grant): Array<PackageCollaboratorView> => {
			const base = {
				grantId: grant.id,
				subjectId: grant.subjectId,
				preset: readPreset(grant.preset),
				permissions: grant.permissions,
				createdAt: grant.createdAt,
			}
			if (grant.subjectType === 'team') {
				const team = teamsById.get(grant.subjectId)
				// A deleted team's leftover grant gives nobody access; leave it out.
				if (!team) return []
				return [
					{
						...base,
						subjectType: 'team',
						kind: 'team',
						label: team.name,
						username: null,
						displayName: null,
						avatarUrl: null,
						teamSlug: team.slug,
						teamMemberCount: team.memberCount,
					},
				]
			}
			const user = users.get(grant.subjectId)
			const username = user?.username ?? null
			return [
				{
					...base,
					subjectType: 'user',
					kind: memberIds.has(grant.subjectId) ? 'member' : 'outside',
					label: username
						? `@${username}`
						: user?.display_name?.trim() || 'Deleted account',
					username,
					displayName: user?.display_name ?? null,
					avatarUrl: username
						? buildUserAvatarUrl({
								username,
								avatarKey: user?.avatar_key ?? null,
							})
						: null,
					teamSlug: null,
					teamMemberCount: null,
				},
			]
		},
	)
	collaborators.sort(
		(left, right) =>
			kindOrder[left.kind] - kindOrder[right.kind] ||
			left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }),
	)

	const grantedTeams = new Set(
		grants.filter((g) => g.subjectType === 'team').map((g) => g.subjectId),
	)
	const grantedUsers = new Set(
		grants.filter((g) => g.subjectType === 'user').map((g) => g.subjectId),
	)
	return {
		collaborators,
		options: {
			teams: teams
				.filter((team) => !grantedTeams.has(team.id))
				.map((team) => ({
					id: team.id,
					slug: team.slug,
					name: team.name,
					memberCount: team.memberCount,
				})),
			// Owners already hold every permission on every package.
			members: members
				.filter(
					(member) =>
						member.role !== 'owner' && !grantedUsers.has(member.userId),
				)
				.map((member) => ({
					userId: member.userId,
					username: member.username,
					displayName: member.displayName,
				})),
		},
	}
}
