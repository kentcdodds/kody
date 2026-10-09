import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg, renameUserHandle } from './provision.ts'
import {
	listOrgsForPerson,
	loadOrgBindingForOrg,
	loadOrgBindingForPerson,
} from './repo.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

test('loadOrgBindingForPerson throws when personal org membership is missing', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail(
		'missing-membership@example.com',
	)
	await expect(loadOrgBindingForPerson(db, stableUserId)).rejects.toThrow(
		/No live personal-org membership/,
	)
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

test('loadOrgBindingForOrg requires membership or a live grant', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const gus = testStableUserIdFromEmail('gus@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await provisionPersonalOrg(db, {
		stableUserId: gus,
		username: 'gus',
		createdAt: '2026-01-02T00:00:00.000Z',
	})

	expect(await loadOrgBindingForOrg(db, ada, ada)).toEqual({
		org: { id: ada, slug: 'ada' },
		role: 'owner',
	})
	expect(await loadOrgBindingForOrg(db, ada, gus)).toBeNull()

	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?, NULL)`,
		)
		.bind(
			'grant-1',
			gus,
			ada,
			gus,
			'2026-01-04T00:00:00.000Z',
			'2026-01-04T00:00:00.000Z',
		)
		.run()

	expect(await loadOrgBindingForOrg(db, ada, gus)).toEqual({
		org: { id: gus, slug: 'gus' },
		role: null,
	})
})

test('listOrgsForPerson unions memberships and live grant orgs', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	const gus = testStableUserIdFromEmail('gus@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await provisionPersonalOrg(db, {
		stableUserId: gus,
		username: 'gus',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?, NULL)`,
		)
		.bind(
			'grant-1',
			gus,
			ada,
			gus,
			'2026-01-04T00:00:00.000Z',
			'2026-01-04T00:00:00.000Z',
		)
		.run()

	const orgs = await listOrgsForPerson(db, ada)
	expect(orgs.map((org) => ({ id: org.id, role: org.role }))).toEqual([
		{ id: ada, role: 'owner' },
		{ id: gus, role: null },
	])
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

test('renameUserHandle can reclaim a retired org-held handle when renaming back', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('roundtrip@example.com')
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
	await renameUserHandle(db, {
		stableUserId,
		oldUsername: 'ada2',
		newUsername: 'ada',
		now: '2026-01-04T00:00:00.000Z',
	})

	const restored = await db
		.prepare(`SELECT user_id, org_id FROM handles WHERE handle = ?`)
		.bind('ada')
		.first<{ user_id: string | null; org_id: string | null }>()
	expect(restored).toEqual({ user_id: stableUserId, org_id: stableUserId })
})
