import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { hashVerificationToken } from './email-verification-tokens.ts'
import {
	AdminEmailVerificationError,
	markAdminUserEmailVerified,
	mintAdminEmailVerificationUrl,
} from './email-verification-admin.ts'

async function createAdminVerifyTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'stripe_plan', 'stripe_customer_id'],
	})
	await db
		.prepare(
			`CREATE TABLE roles (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				name TEXT NOT NULL UNIQUE
			)`,
		)
		.run()
	await db.prepare(`INSERT INTO roles (name) VALUES ('user')`).run()
	await db
		.prepare(
			`CREATE TABLE user_roles (
				user_id INTEGER NOT NULL,
				role_id INTEGER NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE email_verifications (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				user_id INTEGER NOT NULL,
				token_hash TEXT NOT NULL UNIQUE,
				expires_at INTEGER NOT NULL,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
			)`,
		)
		.run()
	const email = 'member@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('member', ?, 'hash', ?)`,
		)
		.bind(email, stableUserId)
		.run()
	await db
		.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (1, 1)`)
		.run()
	return { db, email, stableUserId }
}

test('admin mark verified and mint verify url cover the operator unblock path', async () => {
	const { db, email, stableUserId } = await createAdminVerifyTestDb()
	const now = new Date('2026-08-28T00:00:00.000Z')

	const minted = await mintAdminEmailVerificationUrl({
		db,
		appBaseUrl: 'https://kody.codes',
		target: { email },
		now,
	})
	expect(minted.user.email_verified).toBe(false)
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/kody.codes\/verify-email\?token=/,
	)
	expect(minted.expiresAt).toBe(now.getTime() + 24 * 60 * 60 * 1000)
	const token = new URL(minted.verifyUrl).searchParams.get('token')
	expect(token).toBeTruthy()
	const stored = await db
		.prepare(`SELECT token_hash FROM email_verifications WHERE user_id = 1`)
		.first<{ token_hash: string }>()
	expect(stored?.token_hash).toBe(await hashVerificationToken(token!))

	const verified = await markAdminUserEmailVerified(db, {
		stableUserId,
		now,
	})
	expect(verified.email_verified).toBe(true)
	expect(verified.email_verified_at).toBe(now.toISOString())
	expect(verified.email_verification_delivery).toBeNull()
	expect(
		await db
			.prepare(`SELECT COUNT(*) AS count FROM email_verifications`)
			.first<{ count: number }>(),
	).toEqual({ count: 0 })

	await expect(
		mintAdminEmailVerificationUrl({
			db,
			appBaseUrl: 'https://kody.codes',
			target: { username: 'member' },
		}),
	).rejects.toBeInstanceOf(AdminEmailVerificationError)

	const again = await markAdminUserEmailVerified(db, { email })
	expect(again.email_verified_at).toBe(now.toISOString())

	await expect(
		markAdminUserEmailVerified(db, { email: 'missing@example.com' }),
	).rejects.toMatchObject({ code: 'not_found' })
})
