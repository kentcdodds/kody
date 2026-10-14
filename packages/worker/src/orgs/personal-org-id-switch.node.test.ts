import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { assertAccountWritableDb } from '#worker/account/deletion-state.ts'
import { isPersonalOrg } from './is-personal-org.ts'
import {
	mintPersonalOrgIdForSignup,
	provisionPersonalOrgForSignup,
} from './signup-provision.ts'
import {
	personalOrgIdForPerson,
	personalOrgIdFromUserRow,
} from './personal-org-id.ts'
import { loadOrgBindingForPerson } from './repo.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db })
	return { sqlite, db }
}

test('signup provision mints orgs.id distinct from stable_user_id and binds it', async () => {
	const { db } = await createDb()
	const stableUserId = testStableUserIdFromEmail('distinct@example.com')
	const personalOrgId = mintPersonalOrgIdForSignup()
	expect(personalOrgId).not.toBe(stableUserId)

	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES ('distinct', 'distinct@example.com', 'hash', ?, ?)`,
		)
		.bind(stableUserId, personalOrgId)
		.run()

	await provisionPersonalOrgForSignup(db, {
		stableUserId,
		orgId: personalOrgId,
		username: 'distinct',
		createdAt: '2026-10-14T00:00:00.000Z',
		plan: 'free',
	})

	const org = await db
		.prepare(`SELECT id, slug FROM orgs WHERE id = ?`)
		.bind(personalOrgId)
		.first<{ id: string; slug: string }>()
	expect(org).toEqual({ id: personalOrgId, slug: 'distinct' })

	const membership = await db
		.prepare(
			`SELECT org_id, user_id, role FROM org_memberships WHERE org_id = ?`,
		)
		.bind(personalOrgId)
		.first<{ org_id: string; user_id: string; role: string }>()
	expect(membership).toEqual({
		org_id: personalOrgId,
		user_id: stableUserId,
		role: 'owner',
	})
	expect(membership?.org_id).not.toBe(membership?.user_id)

	const binding = await loadOrgBindingForPerson(db, stableUserId)
	expect(binding.org.id).toBe(personalOrgId)
	expect(binding.role).toBe('owner')

	expect(await isPersonalOrg(db, personalOrgId)).toBe(true)
	expect(await isPersonalOrg(db, stableUserId)).toBe(false)
})

test('legacy equal-id personal org still binds and isPersonalOrg', async () => {
	const { db } = await createDb()
	const stableUserId = testStableUserIdFromEmail('legacy@example.com')
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES ('legacy', 'legacy@example.com', 'hash', ?, ?)`,
		)
		.bind(stableUserId, stableUserId)
		.run()
	await provisionPersonalOrgForSignup(db, {
		stableUserId,
		orgId: stableUserId,
		username: 'legacy',
		createdAt: '2026-10-14T00:00:00.000Z',
	})

	const binding = await loadOrgBindingForPerson(db, stableUserId)
	expect(binding.org.id).toBe(stableUserId)
	expect(await isPersonalOrg(db, stableUserId)).toBe(true)
})

test('stamped personalOrgId drives request org, owner key, and write fence', async () => {
	const { db } = await createDb()
	const stableUserId = testStableUserIdFromEmail('stamp@example.com')
	const personalOrgId = mintPersonalOrgIdForSignup()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES ('stamp', 'stamp@example.com', 'hash', ?, ?)`,
		)
		.bind(stableUserId, personalOrgId)
		.run()
	await provisionPersonalOrgForSignup(db, {
		stableUserId,
		orgId: personalOrgId,
		username: 'stamp',
		createdAt: '2026-10-14T00:00:00.000Z',
	})

	const personId = personIdFromStored(stableUserId)
	const stamped = personalOrgIdFromUserRow({
		personal_org_id: personalOrgId,
		stable_user_id: stableUserId,
	})
	expect(stamped).toBe(personalOrgId)
	expect(
		personalOrgIdForPerson({ userId: personId, personalOrgId: stamped }),
	).toBe(personalOrgId)

	const request = deriveRequestContext({
		user: {
			userId: personId,
			username: 'stamp',
			personalOrgId: stamped,
		},
		source: { kind: 'session' },
	})
	expect(request.org.id).toBe(personalOrgId)
	expect(
		ownerIdFromCaller({
			request,
			user: { userId: personId, personalOrgId: stamped },
		}),
	).toBe(personalOrgId)
	await expect(assertAccountWritableDb(db, stamped)).resolves.toBeUndefined()
	await expect(
		assertAccountWritableDb(db, personalOrgIdForPerson({ userId: personId })),
	).resolves.toBeUndefined()
})
