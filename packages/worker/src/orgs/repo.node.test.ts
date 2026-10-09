import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg, renameUserHandle } from './provision.ts'
import { loadOrgBindingForPerson } from './repo.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

test('loadOrgBindingForPerson falls back when personal org membership is missing', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail(
		'missing-membership@example.com',
	)
	expect(await loadOrgBindingForPerson(db, stableUserId)).toEqual({
		org: { id: stableUserId, slug: null },
		role: 'owner',
	})
})

test('loadOrgBindingForPerson returns personal org slug and owner role', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})

	expect(await loadOrgBindingForPerson(db, stableUserId)).toEqual({
		org: { id: stableUserId, slug: 'ada' },
		role: 'owner',
	})
})

test('renameUserHandle keeps org slug on the original handle row', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await renameUserHandle(db, {
		stableUserId,
		oldUsername: 'ada',
		newUsername: 'ada2',
		now: '2026-01-03T00:00:00.000Z',
	})

	const oldHandle = await db
		.prepare(`SELECT user_id, org_id FROM handles WHERE handle = ?`)
		.bind('ada')
		.first<{ user_id: string | null; org_id: string | null }>()
	expect(oldHandle).toEqual({ user_id: null, org_id: stableUserId })

	const newHandle = await db
		.prepare(`SELECT user_id, org_id FROM handles WHERE handle = ?`)
		.bind('ada2')
		.first<{ user_id: string | null; org_id: string | null }>()
	expect(newHandle).toEqual({ user_id: stableUserId, org_id: null })

	expect(await loadOrgBindingForPerson(db, stableUserId)).toEqual({
		org: { id: stableUserId, slug: 'ada' },
		role: 'owner',
	})
})
