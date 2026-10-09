import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg, renameUserHandle } from './provision.ts'
import {
	countPendingInvitesForPerson,
	listOrganizationsForPerson,
	listOrgsForPerson,
	loadOrgBindingForOrg,
	loadOrgBindingForPerson,
	loadOrgBindingForSlug,
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

test('listOrganizationsForPerson puts the signup organization first and includes grant-only orgs', async () => {
	const db = await createDb()
	const stableUserId = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const otherId = 'b'.repeat(64)
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'zeta', 'Zeta', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(otherId)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(otherId, stableUserId)
		.run()
	const grantOrgId = 'c'.repeat(64)
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'acme', 'Acme', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(grantOrgId)
		.run()
	await db
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-1', ?, 'package', 'pkg-1', 'user', ?, ?, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
		)
		.bind(grantOrgId, stableUserId, stableUserId)
		.run()

	const listed = await listOrganizationsForPerson(db, stableUserId)
	expect(listed.map((org) => org.slug)).toEqual(['ada', 'acme', 'zeta'])
	expect(listed.find((org) => org.slug === 'ada')).toMatchObject({
		role: 'owner',
		personal: true,
	})
	expect(listed.find((org) => org.slug === 'acme')).toMatchObject({
		role: null,
		personal: false,
	})
	expect(await loadOrgBindingForSlug(db, stableUserId, 'acme')).toEqual({
		org: { id: grantOrgId, slug: 'acme' },
		role: null,
	})
	expect(await loadOrgBindingForSlug(db, stableUserId, 'missing')).toBeNull()

	await db
		.prepare(
			`INSERT INTO invites (
			   id, org_id, kind, invitee_email, token_hash, status,
			   invited_by_user_id, expires_at, created_at
			 ) VALUES (
			   'invite-1', ?, 'membership', 'ada@example.com', 'hash-1', 'pending',
			   ?, '2099-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
			 )`,
		)
		.bind(otherId, stableUserId)
		.run()
	expect(
		await countPendingInvitesForPerson(db, {
			email: 'Ada@Example.com',
			username: 'ada',
			now: '2026-02-01T00:00:00.000Z',
		}),
	).toBe(1)
})
