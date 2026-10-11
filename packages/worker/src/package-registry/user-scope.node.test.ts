import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	getMcpUserPackageScope,
	getPackageScopeByUserId,
} from './user-scope.ts'

type UsernameRow = {
	username: string | null
}

function createMockAppDb(options: {
	rowByStableUserId?: UsernameRow | null
	rowByEmail?: UsernameRow | null
	orgSlugById?: string | null
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
							if (
								normalized.includes('from orgs') &&
								normalized.includes('where id = ?')
							) {
								const slug = options.orgSlugById
								return (slug ? { slug } : null) as T | null
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
			userId: personIdFromStored('stable-1'),
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
			userId: personIdFromStored('stable-2'),
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
		orgSlugById: null,
	})
	await expect(
		getMcpUserPackageScope(missing.db, {
			userId: personIdFromStored('orphan-stable'),
			email: 'orphan@example.com',
			displayName: 'Orphan',
		}),
	).rejects.toThrow(
		'Cannot validate package scope because the signed-in user record was not found.',
	)
	expect(missing.queries[0]?.params).toEqual(['orphan-stable'])
})

test('getPackageScopeByUserId falls back to the org slug for team owners', async () => {
	const teamOrg = createMockAppDb({
		rowByStableUserId: null,
		orgSlugById: 'rocket-co',
	})
	await expect(
		getPackageScopeByUserId(teamOrg.db, ownerIdFromStored('org-team')),
	).resolves.toBe('rocket-co')
	expect(teamOrg.queries).toHaveLength(2)
	expect(teamOrg.queries[1]?.sql).toMatch(/from orgs/i)
})
