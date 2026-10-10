import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test } from 'vitest'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { addTeamMember, createTeam } from '#worker/orgs/access-writes.ts'
import {
	listTeamMembers,
	listTeams,
	listTeamsWithMembers,
} from '#worker/orgs/org-teams-list.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const ada = { id: 1, personId: 'a'.repeat(64) }
const bob = { id: 2, personId: 'b'.repeat(64) }

let db: D1Database
let orgId = ''

beforeEach(async () => {
	const sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	const now = '2026-01-01T00:00:00.000Z'
	for (const [username, person] of [
		['ada', ada],
		['bob', bob],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id, display_name)
				 VALUES (?, ?, ?, 'x', ?, ?)`,
			)
			.run(
				person.id,
				username,
				`${username}@example.com`,
				person.personId,
				username,
			)
		await provisionPersonalOrg(db, {
			stableUserId: person.personId,
			username,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: ada.personId,
			slug: 'zeta-co',
			displayName: 'Zeta Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	orgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>())!.id
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.run(orgId, bob.personId, now)
})

test('listTeams returns empty then teams with member counts', async () => {
	expect(await listTeams(db, orgId)).toEqual([])
	const team = await createTeam({
		db,
		orgId,
		slug: 'platform',
		name: 'Platform',
		createdByUserId: ada.personId,
	})
	await addTeamMember({
		db,
		orgId,
		teamId: team.id,
		userId: bob.personId,
		addedByUserId: ada.personId,
	})
	expect(await listTeams(db, orgId)).toEqual([
		{
			id: team.id,
			slug: 'platform',
			name: 'Platform',
			description: null,
			memberCount: 1,
		},
	])
	expect(await listTeamMembers(db, orgId, team.id)).toEqual([
		{
			userId: bob.personId,
			username: 'bob',
			displayName: 'bob',
			avatarKey: null,
		},
	])
	const withMembers = await listTeamsWithMembers(db, orgId)
	expect(withMembers).toHaveLength(1)
	expect(withMembers[0]?.members.map((member) => member.username)).toEqual([
		'bob',
	])
})
