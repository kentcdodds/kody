import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	assertMemoryGrantsAllowedOnOrg,
	assertPersonalMemoryWritable,
} from './memory-owner.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	return db
}

test('assertPersonalMemoryWritable allows personal orgs and freezes team orgs', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada-freeze@example.com')
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (1, 'ada-freeze', 'ada-freeze@example.com', 'x', ?)`,
		)
		.bind(ada)
		.run()
	await provisionPersonalOrg(db, { stableUserId: ada, username: 'ada-freeze' })
	await assertPersonalMemoryWritable(db, ownerIdFromStored(ada))

	const created = await createOrganization(db, {} as Env, {
		personId: ada,
		audit: createTestOrgAuditWriter(),
		slug: 'freeze-team-co',
		displayName: 'Freeze Team',
	})
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'freeze-team-co'`)
		.first<{ id: string }>()
	await expect(
		assertPersonalMemoryWritable(db, ownerIdFromStored(org!.id)),
	).rejects.toThrow(/write or delete only in your personal org/i)
	await expect(
		assertMemoryGrantsAllowedOnOrg(db, ownerIdFromStored(org!.id)),
	).rejects.toThrow(/New memory grants are only allowed on a personal org/)
})
