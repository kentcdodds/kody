import { expect, test } from 'vitest'
import {
	buildEmailVerificationUrl,
	isAccountEmailVerified,
} from '#app/email-verification.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

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
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql, params })
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
	return { db, queries }
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

	expect(
		combined.queries.every((query) =>
			query.sql.toLowerCase().includes('email = ? and stable_user_id = ?'),
		),
	).toBe(true)

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

	expect(singleKey.queries[0]?.sql.toLowerCase()).toContain('where email = ?')
	expect(singleKey.queries[0]?.sql.toLowerCase()).not.toContain(
		'stable_user_id',
	)
	expect(singleKey.queries[1]?.sql.toLowerCase()).toContain(
		'where stable_user_id = ?',
	)
})
