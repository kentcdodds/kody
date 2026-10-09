import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createOrganization } from './create-organization.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return { db, sqlite }
}

const env = {} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>

test('createOrganization inserts org, membership, and handle together', async () => {
	const { db } = await createDb()
	const personId = testStableUserIdFromEmail('ada@example.com')
	const result = await createOrganization(db, env, {
		personId,
		slug: 'zeta-co',
		displayName: 'Zeta Co',
	})
	expect(result).toEqual({ ok: true, slug: 'zeta-co' })
	const org = await db
		.prepare(`SELECT id, slug FROM orgs WHERE slug = ?`)
		.bind('zeta-co')
		.first<{ id: string; slug: string }>()
	expect(org?.slug).toBe('zeta-co')
	const membership = await db
		.prepare(
			`SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ?`,
		)
		.bind(org!.id, personId)
		.first<{ role: string }>()
	expect(membership).toEqual({ role: 'owner' })
	const handle = await db
		.prepare(`SELECT user_id, org_id FROM handles WHERE handle = ?`)
		.bind('zeta-co')
		.first<{ user_id: string | null; org_id: string }>()
	expect(handle).toEqual({ user_id: null, org_id: org!.id })
})

test('createOrganization rolls back when the handle insert conflicts', async () => {
	const { db } = await createDb()
	const personId = testStableUserIdFromEmail('ada@example.com')
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES ('zeta-co', ?, NULL, '2026-01-01T00:00:00.000Z')`,
		)
		.bind(personId)
		.run()

	// Bypass the pre-check so the batch hits the unique conflict on handles.
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		const statement = originalPrepare(query)
		if (query.includes('SELECT handle FROM handles WHERE handle = ?')) {
			return {
				bind: () => ({
					first: async () => null,
					run: statement.bind().run,
					all: statement.bind().all,
					raw: statement.bind().raw,
				}),
			} as ReturnType<D1Database['prepare']>
		}
		return statement
	}) as D1Database['prepare']

	const result = await createOrganization(db, env, {
		personId,
		slug: 'zeta-co',
		displayName: 'Zeta Co',
	})
	expect(result).toEqual({ ok: false, error: 'That name is taken.' })
	expect(
		await db
			.prepare(`SELECT COUNT(*) AS count FROM orgs WHERE slug = ?`)
			.bind('zeta-co')
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
	expect(
		await db
			.prepare(
				`SELECT COUNT(*) AS count FROM org_memberships WHERE user_id = ?`,
			)
			.bind(personId)
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
})
