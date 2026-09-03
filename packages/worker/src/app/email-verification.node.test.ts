import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
	buildEmailVerificationUrl,
	hashVerificationToken,
	isAccountEmailVerified,
	verifyEmailToken,
} from '#app/email-verification.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

test('email verification links preserve safe resume targets and reject open redirects', () => {
	const oauthResume = '/oauth/authorize?client_id=demo&state=abc'
	const withResume = buildEmailVerificationUrl({
		appBaseUrl: 'https://kody.example',
		token: 'verify-token',
		redirectTo: oauthResume,
	})
	expect(withResume.pathname).toBe('/verify-email')
	expect(withResume.searchParams.get('token')).toBe('verify-token')
	expect(withResume.searchParams.get('redirectTo')).toBe(oauthResume)

	const withoutResume = buildEmailVerificationUrl({
		appBaseUrl: 'https://kody.example',
		token: 'verify-token',
		redirectTo: 'https://evil.example',
	})
	expect(withoutResume.searchParams.get('token')).toBe('verify-token')
	expect(withoutResume.searchParams.has('redirectTo')).toBe(false)
})

type VerificationUser = {
	email: string
	stable_user_id: string
	email_verified_at: string | null
}

function createVerificationTestDb(users: Array<VerificationUser>) {
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
					return {
						async first<T>() {
							if (
								normalized.includes('where email = ? and stable_user_id = ?')
							) {
								const row = users.find(
									(user) =>
										user.email === params[0] &&
										user.stable_user_id === params[1],
								)
								return (
									row ? { email_verified_at: row.email_verified_at } : null
								) as T | null
							}
							if (
								normalized.includes('where email = ?') &&
								!normalized.includes('stable_user_id')
							) {
								const row = users.find((user) => user.email === params[0])
								return (
									row ? { email_verified_at: row.email_verified_at } : null
								) as T | null
							}
							if (normalized.includes('where stable_user_id = ?')) {
								const row = users.find(
									(user) => user.stable_user_id === params[0],
								)
								return (
									row ? { email_verified_at: row.email_verified_at } : null
								) as T | null
							}
							throw new Error(`Unsupported query: ${sql}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return { db }
}

test('isAccountEmailVerified binds email+stable id together and keeps single-key lookup paths', async () => {
	const ownerEmail = 'owner@example.com'
	const ownerStableId = await createStableUserIdFromEmail(ownerEmail)
	const reusedEmail = 'reused@example.com'
	const otherStableId = await createStableUserIdFromEmail(
		'other-account@example.com',
	)
	const combined = createVerificationTestDb([
		{
			email: ownerEmail,
			stable_user_id: ownerStableId,
			email_verified_at: '2026-01-01T00:00:00.000Z',
		},
		{
			email: reusedEmail,
			stable_user_id: otherStableId,
			email_verified_at: '2026-01-02T00:00:00.000Z',
		},
	])

	expect(
		await isAccountEmailVerified({
			db: combined.db,
			email: ownerEmail,
			stableUserId: ownerStableId,
		}),
	).toBe(true)

	// Stale grant email now owned by another verified account must not pass
	// for the original stable id.
	expect(
		await isAccountEmailVerified({
			db: combined.db,
			email: reusedEmail,
			stableUserId: ownerStableId,
		}),
	).toBe(false)

	const email = 'browser@example.com'
	const stableUserId = await createStableUserIdFromEmail(email)
	const singleKey = createVerificationTestDb([
		{
			email,
			stable_user_id: stableUserId,
			email_verified_at: '2026-01-01T00:00:00.000Z',
		},
	])

	expect(await isAccountEmailVerified({ db: singleKey.db, email })).toBe(true)
	expect(await isAccountEmailVerified({ db: singleKey.db, stableUserId })).toBe(
		true,
	)
	expect(
		await isAccountEmailVerified({
			db: singleKey.db,
			email: 'missing@example.com',
		}),
	).toBe(false)
	expect(
		await isAccountEmailVerified({
			db: singleKey.db,
			stableUserId: 'missing-stable-id',
		}),
	).toBe(false)
})

test('verifyEmailToken treats a fenced account as an invalid token and does not mark it verified', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const email = 'fenced-verify@example.com'
	const stableUserId = await createStableUserIdFromEmail(email)
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, deleting_at
			) VALUES (?, ?, 'hash', ?, ?)`,
		)
		.bind('fenced-verify', email, stableUserId, '2026-09-02 12:00:00')
		.run()
	const token = 'fenced-verify-token'
	const tokenHash = await hashVerificationToken(token)
	await db
		.prepare(
			`INSERT INTO email_verifications (user_id, token_hash, expires_at)
			 VALUES (1, ?, ?)`,
		)
		.bind(tokenHash, Date.now() + 60_000)
		.run()

	await expect(verifyEmailToken({ db, token })).resolves.toEqual({
		ok: false,
		reason: 'invalid_token',
	})
	const row = sqlite
		.prepare(`SELECT email_verified_at FROM users WHERE id = 1`)
		.get() as { email_verified_at: string | null }
	expect(row.email_verified_at).toBeNull()
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

test('verifyEmailToken does not mark verified when a purge claim lands between the writable check and the stamp', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = withDeletingAtAfterWritableCheck(
		createD1FromSqlite(sqlite),
		'2026-09-02 12:00:00',
	)
	const email = 'race-verify@example.com'
	const stableUserId = await createStableUserIdFromEmail(email)
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id
			) VALUES (?, ?, 'hash', ?)`,
		)
		.bind('race-verify', email, stableUserId)
		.run()
	const token = 'race-verify-token'
	const tokenHash = await hashVerificationToken(token)
	await db
		.prepare(
			`INSERT INTO email_verifications (user_id, token_hash, expires_at)
			 VALUES (1, ?, ?)`,
		)
		.bind(tokenHash, Date.now() + 60_000)
		.run()

	await expect(verifyEmailToken({ db, token })).resolves.toEqual({
		ok: false,
		reason: 'invalid_token',
	})
	const row = sqlite
		.prepare(`SELECT email_verified_at, deleting_at FROM users WHERE id = 1`)
		.get() as { email_verified_at: string | null; deleting_at: string | null }
	expect(row.email_verified_at).toBeNull()
	expect(row.deleting_at).toBe('2026-09-02 12:00:00')
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM email_verifications`).get(),
	).toEqual({ count: 1 })
})
