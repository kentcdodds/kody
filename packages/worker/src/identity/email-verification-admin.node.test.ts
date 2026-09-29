import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { hashVerificationToken } from './email-verification-tokens.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import {
	AdminEmailVerificationError,
	markAdminUserEmailVerified,
	mintAdminEmailVerificationUrl,
} from './email-verification-admin.ts'

const appBaseUrl = 'https://kody.codes'
const deletingAt = '2026-09-02 12:00:00'

function createAdminVerifyTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const email = 'member@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			VALUES (1, 'member', ?, 'hash', ?)`,
		)
		.run(email, stableUserId)
	sqlite.exec(`INSERT INTO user_roles (user_id, role_id) VALUES (1, 1)`)
	const readUser = () =>
		sqlite
			.prepare(`SELECT email_verified_at, deleting_at FROM users WHERE id = 1`)
			.get()
	const verificationCount = () =>
		sqlite.prepare(`SELECT COUNT(*) AS count FROM email_verifications`).get()
			?.count
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
		email,
		stableUserId,
		readUser,
		verificationCount,
	}
}

test('admin mark verified and mint verify url cover the operator unblock path', async () => {
	const { sqlite, db, email, stableUserId, verificationCount } =
		createAdminVerifyTestDb()
	const now = new Date('2026-08-28T00:00:00.000Z')

	const minted = await mintAdminEmailVerificationUrl({
		db,
		appBaseUrl,
		target: { email },
		now,
	})
	expect(minted.user.email_verified).toBe(false)
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/kody.codes\/verify-email\?token=/,
	)
	expect(minted.expiresAt).toBeGreaterThan(now.getTime())
	const token = new URL(minted.verifyUrl).searchParams.get('token')
	expect(token).toBeTruthy()
	expect(
		sqlite
			.prepare(`SELECT token_hash FROM email_verifications WHERE user_id = 1`)
			.all(),
	).toEqual([{ token_hash: await hashVerificationToken(token!) }])

	const verified = await markAdminUserEmailVerified(db, { stableUserId, now })
	expect(verified.email_verified).toBe(true)
	expect(verified.email_verified_at).toBe(now.toISOString())
	expect(verified.email_verification_delivery).toBeNull()
	expect(verificationCount()).toBe(0)

	await expect(
		mintAdminEmailVerificationUrl({
			db,
			appBaseUrl,
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
	const { sqlite, db, email, readUser, verificationCount } =
		createAdminVerifyTestDb()
	sqlite
		.prepare(`UPDATE users SET deleting_at = ? WHERE id = 1`)
		.run(deletingAt)

	await expect(
		markAdminUserEmailVerified(db, { email }),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	await expect(
		mintAdminEmailVerificationUrl({ db, appBaseUrl, target: { email } }),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(readUser()).toEqual({
		email_verified_at: null,
		deleting_at: deletingAt,
	})
	expect(verificationCount()).toBe(0)
})

function withDeletingAtAfterWritableCheck(db: D1Database): D1Database {
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
	const marking = createAdminVerifyTestDb()
	await expect(
		markAdminUserEmailVerified(withDeletingAtAfterWritableCheck(marking.db), {
			email: marking.email,
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(marking.readUser()).toEqual({
		email_verified_at: null,
		deleting_at: deletingAt,
	})

	const minting = createAdminVerifyTestDb()
	await expect(
		mintAdminEmailVerificationUrl({
			db: withDeletingAtAfterWritableCheck(minting.db),
			appBaseUrl,
			target: { email: minting.email },
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(minting.verificationCount()).toBe(0)
})
