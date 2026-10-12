import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { isPersonalOrg } from './is-personal-org.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg } from './provision.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db })
	return { db, sqlite }
}

async function insertPerson(
	db: D1Database,
	input: { id: number; personId: string; username: string },
) {
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (?, ?, ?, 'x', ?)`,
		)
		.bind(
			input.id,
			input.username,
			`${input.username}@example.com`,
			input.personId,
		)
		.run()
}

test('isPersonalOrg is true only when a live person owns the org id', async () => {
	const { db } = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await insertPerson(db, { id: 1, personId: ada, username: 'ada' })
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	expect(await isPersonalOrg(db, ada)).toBe(true)
	expect(await isPersonalOrg(db, 'f'.repeat(64))).toBe(false)
})

test('isPersonalOrg stays true after the founding membership is soft-deleted', async () => {
	const { db } = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await insertPerson(db, { id: 1, personId: ada, username: 'ada' })
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.bind('2026-03-01T00:00:00.000Z', ada, ada)
		.run()
	expect(await isPersonalOrg(db, ada)).toBe(true)
})

test('former platform orgs are not personal after the users row is gone', async () => {
	const { db } = await createDb()
	// Mimic migration 0099: org id equals the deleted platform stable id, the
	// founding self-membership is soft-deleted, and no users row remains.
	const platformId = testStableUserIdFromEmail('kody@platform.example')
	const ownerId = testStableUserIdFromEmail('kent@example.com')
	const now = '2026-01-02T00:00:00.000Z'
	await insertPerson(db, { id: 2, personId: ownerId, username: 'kent' })
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'kody', 'Kody', ?, ?)`,
		)
		.bind(platformId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'owner', ?, ?)`,
		)
		.bind(platformId, platformId, now, '2026-10-10T00:00:00.000Z')
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(platformId, ownerId, now)
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('kody', ?, ?)`,
		)
		.bind(platformId, now)
		.run()

	expect(await isPersonalOrg(db, platformId)).toBe(false)
	// The human owner's stable id is still their personal-org id.
	expect(await isPersonalOrg(db, ownerId)).toBe(true)
})
