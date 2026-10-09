import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
	isEmailReservedForOtherAccount,
	listFormerEmailClaims,
	releaseAccountEmailClaim,
	resolveReleasableEmailClaim,
} from './email-claims.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function insertUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		email: string
		username: string
		stableUserId?: string
	},
) {
	const stableUserId =
		input.stableUserId ?? testStableUserIdFromEmail(input.email)
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			'hash'
		);
	`)
	return stableUserId
}

test('email claims reserve former addresses without reminting identity', async () => {
	const { sqlite, db } = createMigratedDb()
	const originalStableUserId = await insertUser(sqlite, {
		id: 1,
		email: 'first@example.com',
		username: 'jamie',
	})
	const currentEmail = 'work@example.com'
	const formerClaims = () =>
		listFormerEmailClaims(db, { userId: 1, currentEmail })
	const releasable = (email: string) =>
		resolveReleasableEmailClaim({
			db,
			userId: 1,
			currentEmail,
			email,
		})
	await claimAccountEmail(db, { userId: 1, email: 'first@example.com' })

	sqlite.exec(`UPDATE users SET email = 'work@example.com' WHERE id = 1`)
	await claimAccountEmail(db, { userId: 1, email: currentEmail })

	expect(await formerClaims()).toEqual([
		{ email: 'first@example.com', claimedAt: expect.any(String) },
	])
	expect(await isEmailReservedForOtherAccount(db, 'first@example.com')).toBe(
		true,
	)
	expect(await allocateSignupIdentity(db, 'first@example.com')).toEqual({
		ok: false,
		reason: 'former_email_claimed',
	})
	expect(await releasable('first@example.com')).toEqual({
		ok: true,
		email: 'first@example.com',
	})

	await releaseAccountEmailClaim(db, { userId: 1, email: 'first@example.com' })
	expect(await formerClaims()).toEqual([])
	expect(await isEmailReservedForOtherAccount(db, 'first@example.com')).toBe(
		false,
	)

	const allocated = await allocateSignupIdentity(db, 'first@example.com')
	if (!allocated.ok) throw new Error('expected allocation')
	expect(allocated.stableUserId).not.toBe(originalStableUserId)
	expect(allocated.stableUserId).toMatch(/^[a-f0-9]{64}$/)
	expect(
		sqlite.prepare(`SELECT stable_user_id FROM users WHERE id = 1`).get(),
	).toEqual({ stable_user_id: originalStableUserId })

	expect(await releasable(currentEmail)).toEqual({
		ok: false,
		reason: 'current_email',
	})
	expect(await releasable('stranger@example.com')).toEqual({
		ok: false,
		reason: 'not_claimed',
	})
})

test('a legacy email-hash id does not reserve its original signup address', async () => {
	const { sqlite, db } = createMigratedDb()
	const originalEmail = 'legacy@example.com'
	await insertUser(sqlite, {
		id: 2,
		email: 'now@example.com',
		username: 'legacy',
		stableUserId: testStableUserIdFromEmail(originalEmail),
	})

	expect(await isEmailReservedForOtherAccount(db, originalEmail)).toBe(false)
	const allocated = await allocateSignupIdentity(db, originalEmail)
	if (!allocated.ok) throw new Error('expected allocation')
	expect(allocated.stableUserId).not.toBe(
		testStableUserIdFromEmail(originalEmail),
	)
	expect(
		await resolveReleasableEmailClaim({
			db,
			userId: 2,
			currentEmail: 'now@example.com',
			email: originalEmail,
		}),
	).toEqual({ ok: false, reason: 'not_claimed' })
})

test('signup identity is random and never the email hash', async () => {
	const { db } = createMigratedDb()
	const email = 'fresh@example.com'
	const first = await allocateSignupIdentity(db, email)
	const second = await allocateSignupIdentity(db, email)
	if (!first.ok || !second.ok) throw new Error('expected allocation')
	expect(first.stableUserId).toMatch(/^[a-f0-9]{64}$/)
	expect(first.stableUserId).not.toBe(testStableUserIdFromEmail(email))
	expect(second.stableUserId).not.toBe(first.stableUserId)
})

test('re-signup after a legacy account is deleted never reuses its email-hash id', async () => {
	const { sqlite, db } = createMigratedDb()
	const email = 'returning@example.com'
	const legacyStableUserId = await insertUser(sqlite, {
		id: 3,
		email,
		username: 'returning',
	})
	expect(legacyStableUserId).toBe(testStableUserIdFromEmail(email))
	expect(await allocateSignupIdentity(db, email)).toEqual({
		ok: false,
		reason: 'current_email',
	})

	sqlite.exec(`DELETE FROM users WHERE id = 3`)
	const allocated = await allocateSignupIdentity(db, email)
	if (!allocated.ok) throw new Error('expected allocation')
	expect(allocated.stableUserId).not.toBe(legacyStableUserId)
})
