import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	getOrgHandleClaimError,
	orgHandleReservedError,
	orgHandleTakenError,
} from './org-handle-claim.ts'
import { ensureOrgsTestSchema } from './orgs-test-schema.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	return { db, sqlite }
}

test('getOrgHandleClaimError rejects built-in reserved handles with username copy', async () => {
	const { db } = await createDb()
	expect(await getOrgHandleClaimError('admin', db)).toBe(orgHandleReservedError)
	expect(await getOrgHandleClaimError('me', db)).toBe(orgHandleReservedError)
	expect(await getOrgHandleClaimError('ME', db)).toBe(orgHandleReservedError)
	expect(await getOrgHandleClaimError('kody-r-0123456789abcdef', db)).toBe(
		orgHandleReservedError,
	)
})

test('getOrgHandleClaimError rejects format failures after reserved', async () => {
	const { db } = await createDb()
	expect(await getOrgHandleClaimError('-bad-', db)).toMatch(
		/3 to 32 characters/,
	)
	expect(await getOrgHandleClaimError('', db)).toBe('Username is required.')
})

test('getOrgHandleClaimError rejects handles claimed by a user username', async () => {
	const { db } = await createDb()
	const personId = testStableUserIdFromEmail('ada@example.com')
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (1, 'ada-lovelace', 'ada@example.com', 'x', ?)`,
		)
		.bind(personId)
		.run()
	expect(await getOrgHandleClaimError('ada-lovelace', db)).toBe(
		orgHandleTakenError,
	)
	expect(await getOrgHandleClaimError('fresh-team', db)).toBeNull()
})

test('getOrgHandleClaimError rejects handles claimed by an org slug or handle row', async () => {
	const { db } = await createDb()
	const now = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES ('org-1', 'zeta-co', 'Zeta', 'free', 'public', ?, ?)`,
		)
		.bind(now, now)
		.run()
	expect(await getOrgHandleClaimError('zeta-co', db)).toBe(orgHandleTakenError)

	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES ('handle-only', NULL, NULL, ?)`,
		)
		.bind(now)
		.run()
	expect(await getOrgHandleClaimError('handle-only', db)).toBe(
		orgHandleTakenError,
	)
})
