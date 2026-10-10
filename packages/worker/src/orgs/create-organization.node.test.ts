import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { MAX_FREE_ORGS_PER_USER } from './billing.ts'
import { createOrganization } from './create-organization.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return { db, sqlite }
}

const env = {} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>
const now = '2026-01-01T00:00:00.000Z'

async function seedFreeOwnedOrg(
	db: D1Database,
	input: { id: string; slug: string; ownerId: string },
) {
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES (?, ?, ?, 'free', 'public', ?, ?)`,
		)
		.bind(input.id, input.slug, input.slug, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(input.id, input.ownerId, now)
		.run()
}

test('createOrganization inserts org, membership, and handle together', async () => {
	const { db } = await createDb()
	const personId = testStableUserIdFromEmail('ada@example.com')
	const result = await createOrganization(db, env, {
		personId,
		audit: createTestOrgAuditWriter(),
		slug: 'zeta-co',
		displayName: 'Zeta Co',
	})
	expect(result).toEqual({ ok: true, slug: 'zeta-co' })
	const org = await db
		.prepare(`SELECT id, slug, plan FROM orgs WHERE slug = ?`)
		.bind('zeta-co')
		.first<{ id: string; slug: string; plan: string }>()
	expect(org).toMatchObject({ slug: 'zeta-co', plan: 'free' })
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

test('createOrganization enforces the same free-org cap as MCP orgCreate', async () => {
	const { db } = await createDb()
	const personId = testStableUserIdFromEmail('cap@example.com')
	expect(MAX_FREE_ORGS_PER_USER).toBe(2)
	await seedFreeOwnedOrg(db, {
		id: 'free-1',
		slug: 'free-one',
		ownerId: personId,
	})
	await seedFreeOwnedOrg(db, {
		id: 'free-2',
		slug: 'free-two',
		ownerId: personId,
	})

	const result = await createOrganization(db, env, {
		personId,
		audit: createTestOrgAuditWriter(),
		slug: 'free-three',
		displayName: 'Free Three',
	})
	expect(result.ok).toBe(false)
	if (result.ok) throw new Error('expected free-org cap')
	expect(result.error).toMatch(/2 free organizations/)
	expect(
		await db
			.prepare(`SELECT COUNT(*) AS count FROM orgs WHERE slug = ?`)
			.bind('free-three')
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
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

	// Bypass the pre-check so the shared createOrg batch hits the unique
	// conflict on handles.
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
		audit: createTestOrgAuditWriter(),
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
