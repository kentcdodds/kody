import { expect, test } from 'vitest'
import { getMcpUserPackageScope } from './user-scope.ts'

type UsernameRow = {
	username: string | null
}

function createMockAppDb(options: {
	rowByStableUserId?: UsernameRow | null
	rowByEmail?: UsernameRow | null
}) {
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql, params })
					return {
						async first<T>() {
							const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
							if (normalized.includes('where stable_user_id = ?')) {
								return (options.rowByStableUserId ?? null) as T | null
							}
							if (normalized.includes('where lower(email) = lower(?)')) {
								return (options.rowByEmail ?? null) as T | null
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

test('getMcpUserPackageScope uses context username, then stable user id — never email', async () => {
	const fromContext = createMockAppDb({
		rowByStableUserId: { username: 'from-db' },
		rowByEmail: { username: 'from-email' },
	})
	await expect(
		getMcpUserPackageScope(fromContext.db, {
			userId: 'stable-1',
			email: 'stale@example.com',
			displayName: 'Caller',
			username: 'From-Context',
		}),
	).resolves.toBe('from-context')
	expect(fromContext.queries).toEqual([])

	const fromStableId = createMockAppDb({
		rowByStableUserId: { username: 'db-user' },
		// Stale email still "resolves" in the old lookup path — must not be used.
		rowByEmail: { username: 'wrong-email-user' },
	})
	await expect(
		getMcpUserPackageScope(fromStableId.db, {
			userId: 'stable-2',
			email: 'no-longer-this@example.com',
			displayName: 'Caller',
		}),
	).resolves.toBe('db-user')
	expect(fromStableId.queries).toHaveLength(1)
	expect(fromStableId.queries[0]?.sql).toMatch(/stable_user_id\s*=\s*\?/i)
	expect(fromStableId.queries[0]?.params).toEqual(['stable-2'])

	const missing = createMockAppDb({
		rowByStableUserId: null,
		rowByEmail: { username: 'email-only-hit' },
	})
	await expect(
		getMcpUserPackageScope(missing.db, {
			userId: 'orphan-stable',
			email: 'orphan@example.com',
			displayName: 'Orphan',
		}),
	).rejects.toThrow(
		'Cannot validate package scope because the signed-in user record was not found.',
	)
	expect(missing.queries[0]?.params).toEqual(['orphan-stable'])
})
