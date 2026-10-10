import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createOrganization } from './create-organization.ts'
import { isPersonalOrg, updateOrgProfile } from './org-profile.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { provisionPersonalOrg } from './provision.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

const env = {} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>

test('updateOrgProfile changes the display name and keeps the handle permanent', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
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

	expect(
		await updateOrgProfile(db, {
			orgId: org!.id,
			displayName: 'Zeta Company',
			slug: 'Zeta-Co',
		}),
	).toEqual({ ok: true, slug: 'zeta-co', displayName: 'Zeta Company' })

	const renamed = await updateOrgProfile(db, {
		orgId: org!.id,
		displayName: 'Zeta Renamed',
		slug: 'zeta-company',
	})
	expect(renamed).toEqual({
		ok: false,
		code: 'validation',
		error:
			'Organization handles are permanent and cannot be changed. You can change the display name instead.',
	})
	expect(
		await db
			.prepare(`SELECT slug, display_name FROM orgs WHERE id = ?`)
			.bind(org!.id)
			.first(),
	).toEqual({ slug: 'zeta-co', display_name: 'Zeta Company' })
	expect(
		await db
			.prepare(`SELECT handle, org_id FROM handles WHERE org_id = ?`)
			.bind(org!.id)
			.all()
			.then((result) => result.results),
	).toEqual([{ handle: 'zeta-co', org_id: org!.id }])
})

test('updateOrgProfile refuses a personal org and rejects a different handle', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	const created = await createOrganization(db, env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'zeta',
		displayName: 'Zeta',
	})
	if (!created.ok) throw new Error(created.error)
	const team = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta'`)
		.first<{ id: string }>()

	expect(
		await updateOrgProfile(db, {
			orgId: ada,
			displayName: 'Ada Org',
			slug: 'ada-renamed',
		}),
	).toMatchObject({ ok: false, code: 'personal' })

	expect(
		await updateOrgProfile(db, {
			orgId: team!.id,
			slug: 'ada',
		}),
	).toMatchObject({ ok: false, code: 'validation' })

	expect(
		await updateOrgProfile(db, {
			orgId: team!.id,
			slug: 'no',
		}),
	).toMatchObject({ ok: false, code: 'validation' })
})

test('isPersonalOrg stays true after the founding membership is soft-deleted', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
		createdAt: '2026-01-02T00:00:00.000Z',
	})
	expect(await isPersonalOrg(db, ada)).toBe(true)
	await db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.bind('2026-03-01T00:00:00.000Z', ada, ada)
		.run()
	expect(await isPersonalOrg(db, ada)).toBe(true)
	expect(
		await updateOrgProfile(db, {
			orgId: ada,
			displayName: 'Nope',
		}),
	).toMatchObject({ ok: false, code: 'personal' })
})
