import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { createOrganization } from './create-organization.ts'
import { listOrgMembers, listPendingOrgInvites } from './org-members-list.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	return { db, sqlite }
}

const env = {} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>

function insertUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		username: string
		email: string
		personId: string
		displayName?: string
	},
) {
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, display_name)
			 VALUES (?, ?, ?, 'x', ?, ?)`,
		)
		.run(
			input.id,
			input.username,
			input.email,
			input.personId,
			input.displayName ?? null,
		)
}

test('listOrgMembers returns live memberships with identity and role', async () => {
	const { db, sqlite } = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const bob = testStableUserIdFromEmail('bob@example.com')
	insertUser(sqlite, {
		id: 1,
		username: 'ada',
		email: 'ada@example.com',
		personId: ada,
		displayName: 'Ada Lovelace',
	})
	insertUser(sqlite, {
		id: 2,
		username: 'bob',
		email: 'bob@example.com',
		personId: bob,
		displayName: 'Bob',
	})
	const created = await createOrganization(db, env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'zeta-co',
		displayName: 'Zeta Co',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(org!.id, bob)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'billing', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`,
		)
		.bind(org!.id, 'gone')
		.run()

	const members = await listOrgMembers(db, org!.id)
	expect(members.map((member) => [member.username, member.role])).toEqual([
		['ada', 'owner'],
		['bob', 'member'],
	])
	expect(members[0]?.displayName).toBe('Ada Lovelace')
})

test('listPendingOrgInvites hides expired and non-pending invites', async () => {
	const { db } = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const created = await createOrganization(db, env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'north',
		displayName: 'North',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'north'`)
		.first<{ id: string }>()
	await db
		.prepare(
			`INSERT INTO invites (
			   id, org_id, kind, role, invitee_email, token_hash, status,
			   invited_by_user_id, expires_at, created_at
			 ) VALUES
			   ('live', ?, 'membership', 'member', 'a@example.com', 'h1', 'pending', ?, '2099-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
			   ('old', ?, 'membership', 'member', 'b@example.com', 'h2', 'pending', ?, '2020-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
			   ('done', ?, 'membership', 'member', 'c@example.com', 'h3', 'accepted', ?, '2099-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(org!.id, ada, org!.id, ada, org!.id, ada)
		.run()

	const invites = await listPendingOrgInvites(
		db,
		org!.id,
		'2026-06-01T00:00:00.000Z',
	)
	expect(invites.map((invite) => invite.id)).toEqual(['live'])
	expect(invites[0]?.inviteeEmail).toBe('a@example.com')
})
