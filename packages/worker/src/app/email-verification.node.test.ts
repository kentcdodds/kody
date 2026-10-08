import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
	buildEmailVerificationUrl,
	hashVerificationToken,
	isAccountEmailVerified,
	verifyEmailToken,
} from '#app/email-verification.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

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
	const lookups: Array<
		[string, (user: VerificationUser, params: Array<unknown>) => boolean]
	> = [
		[
			'where email = ? and stable_user_id = ?',
			(user, [email, stableUserId]) =>
				user.email === email && user.stable_user_id === stableUserId,
		],
		['where email = ?', (user, [email]) => user.email === email],
		[
			'where stable_user_id = ?',
			(user, [stableUserId]) => user.stable_user_id === stableUserId,
		],
	]
	return {
		prepare(sql: string) {
			const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
			const lookup = lookups.find(([clause]) => normalized.includes(clause))
			if (!lookup) throw new Error(`Unsupported query: ${sql}`)
			return {
				bind: (...params: Array<unknown>) => ({
					async first() {
						const row = users.find((user) => lookup[1](user, params))
						return row ? { email_verified_at: row.email_verified_at } : null
					},
				}),
			}
		},
	} as unknown as D1Database
}

test('isAccountEmailVerified binds email+stable id together and keeps single-key lookup paths', async () => {
	const ownerEmail = 'owner@example.com'
	const ownerStableId = testStableUserIdFromEmail(ownerEmail)
	const reusedEmail = 'reused@example.com'
	const otherStableId = testStableUserIdFromEmail('other-account@example.com')
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
			db: combined,
			email: ownerEmail,
			stableUserId: ownerStableId,
		}),
	).toBe(true)

	// Stale grant email now owned by another verified account must not pass
	// for the original stable id.
	expect(
		await isAccountEmailVerified({
			db: combined,
			email: reusedEmail,
			stableUserId: ownerStableId,
		}),
	).toBe(false)

	const email = 'browser@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const singleKey = createVerificationTestDb([
		{
			email,
			stable_user_id: stableUserId,
			email_verified_at: '2026-01-01T00:00:00.000Z',
		},
	])

	expect(await isAccountEmailVerified({ db: singleKey, email })).toBe(true)
	expect(await isAccountEmailVerified({ db: singleKey, stableUserId })).toBe(
		true,
	)
	expect(
		await isAccountEmailVerified({
			db: singleKey,
			email: 'missing@example.com',
		}),
	).toBe(false)
	expect(
		await isAccountEmailVerified({
			db: singleKey,
			stableUserId: 'missing-stable-id',
		}),
	).toBe(false)
})

async function seedPendingVerification(
	db: D1Database,
	input: { username: string; deletingAt?: string },
) {
	const email = `${input.username}@example.com`
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, deleting_at
			) VALUES (?, ?, 'hash', ?, ?)`,
		)
		.bind(
			input.username,
			email,
			testStableUserIdFromEmail(email),
			input.deletingAt ?? null,
		)
		.run()
	const token = `${input.username}-token`
	await db
		.prepare(
			`INSERT INTO email_verifications (user_id, token_hash, expires_at)
			 VALUES (1, ?, ?)`,
		)
		.bind(await hashVerificationToken(token), Date.now() + 60_000)
		.run()
	return token
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('verifyEmailToken treats a fenced account as an invalid token and does not mark it verified', async () => {
	const { sqlite, db } = createMigratedDb()
	const token = await seedPendingVerification(db, {
		username: 'fenced-verify',
		deletingAt: '2026-09-02 12:00:00',
	})

	await expect(verifyEmailToken({ db, token })).resolves.toEqual({
		ok: false,
		reason: 'invalid_token',
	})
	expect(
		sqlite.prepare(`SELECT email_verified_at FROM users WHERE id = 1`).get(),
	).toEqual({ email_verified_at: null })
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
	const { sqlite, db: rawDb } = createMigratedDb()
	const db = withDeletingAtAfterWritableCheck(rawDb, '2026-09-02 12:00:00')
	const token = await seedPendingVerification(db, { username: 'race-verify' })

	await expect(verifyEmailToken({ db, token })).resolves.toEqual({
		ok: false,
		reason: 'invalid_token',
	})
	expect(
		sqlite
			.prepare(`SELECT email_verified_at, deleting_at FROM users WHERE id = 1`)
			.get(),
	).toEqual({ email_verified_at: null, deleting_at: '2026-09-02 12:00:00' })
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM email_verifications`).get(),
	).toEqual({ count: 1 })
})
