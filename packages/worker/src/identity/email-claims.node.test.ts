import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
	isEmailReservedForOtherAccount,
	listFormerEmailClaims,
	releaseAccountEmailClaim,
	resolveReleasableEmailClaim,
} from './email-claims.ts'

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
		input.stableUserId ?? (await createStableUserIdFromEmail(input.email))
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
	await claimAccountEmail(db, { userId: 1, email: 'first@example.com' })

	sqlite.exec(`UPDATE users SET email = 'work@example.com' WHERE id = 1`)
	await claimAccountEmail(db, { userId: 1, email: 'work@example.com' })

	expect(
		await listFormerEmailClaims(db, {
			userId: 1,
			currentEmail: 'work@example.com',
		}),
	).toEqual([
		{
			email: 'first@example.com',
			claimedAt: expect.any(String),
		},
	])
	expect(await isEmailReservedForOtherAccount(db, 'first@example.com')).toBe(
		true,
	)
	expect(await allocateSignupIdentity(db, 'first@example.com')).toEqual({
		ok: false,
		reason: 'former_email_claimed',
	})

	const implicit = await resolveReleasableEmailClaim({
		db,
		userId: 1,
		stableUserId: originalStableUserId,
		currentEmail: 'work@example.com',
		email: 'first@example.com',
	})
	expect(implicit).toEqual({ ok: true, email: 'first@example.com' })

	await releaseAccountEmailClaim(db, {
		userId: 1,
		email: 'first@example.com',
	})
	expect(
		await listFormerEmailClaims(db, {
			userId: 1,
			currentEmail: 'work@example.com',
		}),
	).toEqual([])
	expect(await isEmailReservedForOtherAccount(db, 'first@example.com')).toBe(
		false,
	)

	const allocated = await allocateSignupIdentity(db, 'first@example.com')
	expect(allocated.ok).toBe(true)
	if (!allocated.ok) throw new Error('expected allocation')
	expect(allocated.stableUserId).not.toBe(originalStableUserId)
	expect(allocated.stableUserId).toMatch(/^[a-f0-9]{64}$/)

	expect(
		sqlite.prepare(`SELECT stable_user_id FROM users WHERE id = 1`).get() as {
			stable_user_id: string
		},
	).toEqual({ stable_user_id: originalStableUserId })

	expect(
		await resolveReleasableEmailClaim({
			db,
			userId: 1,
			stableUserId: originalStableUserId,
			currentEmail: 'work@example.com',
			email: 'work@example.com',
		}),
	).toEqual({ ok: false, reason: 'current_email' })
	expect(
		await resolveReleasableEmailClaim({
			db,
			userId: 1,
			stableUserId: originalStableUserId,
			currentEmail: 'work@example.com',
			email: 'stranger@example.com',
		}),
	).toEqual({ ok: false, reason: 'not_claimed' })
})

test('implicit sha256 reservation is releasable before a claim row exists', async () => {
	const { sqlite, db } = createMigratedDb()
	const originalEmail = 'legacy@example.com'
	const stableUserId = await insertUser(sqlite, {
		id: 2,
		email: 'now@example.com',
		username: 'legacy',
		stableUserId: await createStableUserIdFromEmail(originalEmail),
	})

	expect(await isEmailReservedForOtherAccount(db, originalEmail)).toBe(true)
	expect(await allocateSignupIdentity(db, originalEmail)).toEqual({
		ok: false,
		reason: 'former_email_claimed',
	})
	expect(
		await resolveReleasableEmailClaim({
			db,
			userId: 2,
			stableUserId,
			currentEmail: 'now@example.com',
			email: originalEmail,
		}),
	).toEqual({ ok: true, email: originalEmail })
})
