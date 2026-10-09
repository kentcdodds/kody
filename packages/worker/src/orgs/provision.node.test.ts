import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { ensurePersonalOrg, provisionPersonalOrg } from './provision.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

test('provisionPersonalOrg creates org, owner membership, and handle', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('ada@example.com')
	const createdAt = '2026-01-02T00:00:00.000Z'
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'Ada',
		createdAt,
		accountType: 'person',
		plan: 'free',
	})

	const org = await db
		.prepare(`SELECT id, slug, plan FROM orgs WHERE id = ?`)
		.bind(stableUserId)
		.first<{ id: string; slug: string; plan: string }>()
	expect(org).toEqual({ id: stableUserId, slug: 'ada', plan: 'free' })

	const membership = await db
		.prepare(
			`SELECT org_id, user_id, role FROM org_memberships WHERE org_id = ?`,
		)
		.bind(stableUserId)
		.first<{ org_id: string; user_id: string; role: string }>()
	expect(membership).toEqual({
		org_id: stableUserId,
		user_id: stableUserId,
		role: 'owner',
	})

	const handle = await db
		.prepare(`SELECT handle, user_id, org_id FROM handles WHERE handle = ?`)
		.bind('ada')
		.first<{ handle: string; user_id: string; org_id: string }>()
	expect(handle).toEqual({
		handle: 'ada',
		user_id: stableUserId,
		org_id: stableUserId,
	})
})

test('ensurePersonalOrg is idempotent when the personal org already exists', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('idempotent@example.com')
	const input = {
		stableUserId,
		username: 'idem',
		createdAt: '2026-01-02T00:00:00.000Z',
	}
	await provisionPersonalOrg(db, input)
	await ensurePersonalOrg(db, { ...input, username: 'idem-renamed' })

	const orgCount = await db
		.prepare(`SELECT COUNT(*) AS count FROM orgs WHERE id = ?`)
		.bind(stableUserId)
		.first<{ count: number }>()
	expect(orgCount?.count).toBe(1)

	const org = await db
		.prepare(`SELECT slug FROM orgs WHERE id = ?`)
		.bind(stableUserId)
		.first<{ slug: string }>()
	expect(org?.slug).toBe('idem')
})
