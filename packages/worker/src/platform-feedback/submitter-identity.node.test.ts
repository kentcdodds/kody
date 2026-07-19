import { expect, test } from 'vitest'
import { resolvePlatformFeedbackSubmitterIdentity } from './submitter-identity.ts'

function createIdentityDb(
	rows: Array<{
		id: number
		username: string
		email: string
		stable_user_id: string | null
	}>,
) {
	const queries: Array<string> = []
	return {
		queries,
		db: {
			prepare(query: string) {
				queries.push(query)
				let stableUserId: string | null = null
				const statement = {
					bind(value: string) {
						stableUserId = value
						return statement
					},
					async first<T>() {
						return (rows.find((row) => row.stable_user_id === stableUserId) ??
							null) as T | null
					},
					async all<T>() {
						return { results: rows as unknown as Array<T> }
					},
				}
				return statement
			},
		} as unknown as D1Database,
	}
}

test('platform feedback submitter identity resolves active accounts and preserves missing stable ids', async () => {
	const active = createIdentityDb([
		{
			id: 42,
			username: 'feedback-author',
			email: 'author@example.com',
			stable_user_id: 'stable-author',
		},
	])
	await expect(
		resolvePlatformFeedbackSubmitterIdentity(active.db, 'stable-author'),
	).resolves.toEqual({
		userId: 'stable-author',
		username: 'feedback-author',
		email: 'author@example.com',
	})
	expect(active.queries).toEqual([
		'SELECT id, email, stable_user_id, username FROM users WHERE stable_user_id = ?',
	])

	const missing = createIdentityDb([])
	await expect(
		resolvePlatformFeedbackSubmitterIdentity(missing.db, 'deleted-author'),
	).resolves.toEqual({
		userId: 'deleted-author',
		username: null,
		email: null,
	})
	expect(missing.queries).toEqual([
		'SELECT id, email, stable_user_id, username FROM users WHERE stable_user_id = ?',
		'SELECT id, email, stable_user_id, username FROM users',
	])
})
