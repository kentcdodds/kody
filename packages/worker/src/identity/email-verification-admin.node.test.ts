import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { hashVerificationToken } from './email-verification-tokens.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
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

test('admin mark verified and mint verify url refuse a fenced account', async () => {
	const { db, email } = await createAdminVerifyTestDb()
	await db
		.prepare(`UPDATE users SET deleting_at = ? WHERE id = 1`)
		.bind('2026-09-02 12:00:00')
		.run()

	await expect(
		markAdminUserEmailVerified(db, { email }),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	await expect(
		mintAdminEmailVerificationUrl({
			db,
			appBaseUrl: 'https://kody.codes',
			target: { email },
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(
		await db
			.prepare(`SELECT email_verified_at FROM users WHERE id = 1`)
			.first<{ email_verified_at: string | null }>(),
	).toEqual({ email_verified_at: null })
	expect(
		await db
			.prepare(`SELECT COUNT(*) AS count FROM email_verifications`)
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
})

function withDeletingAtAfterWritableCheck(
	db: D1Database,
	deletingAt: string,
): D1Database {
	const originalPrepare = db.prepare.bind(db)
	return {
		...db,
		prepare(query: string) {
			const statement = originalPrepare(query)
			const normalized = query.replace(/\s+/g, ' ').toLowerCase()
			if (
				!normalized.includes('select deleting_at from users') ||
				!normalized.includes('stable_user_id')
			) {
				return statement
			}
			return {
				...statement,
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async first<T>() {
							const row = await bound.first<T>()
							await originalPrepare(
								`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
							)
								.bind(deletingAt, params[0])
								.run()
							return row
						},
					}
				},
			}
		},
	} as D1Database
}

test('admin mark verified and mint verify url refuse a purge claim that lands after the writable check', async () => {
	const { db: rawDb, email } = await createAdminVerifyTestDb()
	const db = withDeletingAtAfterWritableCheck(rawDb, '2026-09-02 12:00:00')

	await expect(
		markAdminUserEmailVerified(db, { email }),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(
		await rawDb
			.prepare(`SELECT email_verified_at, deleting_at FROM users WHERE id = 1`)
			.first<{
				email_verified_at: string | null
				deleting_at: string | null
			}>(),
	).toEqual({
		email_verified_at: null,
		deleting_at: '2026-09-02 12:00:00',
	})

	const { db: rawMintDb, email: mintEmail } = await createAdminVerifyTestDb()
	const mintDb = withDeletingAtAfterWritableCheck(
		rawMintDb,
		'2026-09-02 12:00:00',
	)
	await expect(
		mintAdminEmailVerificationUrl({
			db: mintDb,
			appBaseUrl: 'https://kody.codes',
			target: { email: mintEmail },
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(
		await rawMintDb
			.prepare(`SELECT COUNT(*) AS count FROM email_verifications`)
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
})
