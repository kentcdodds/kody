import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	getUserRolesAndPermissions: vi.fn(),
}))

vi.mock('#app/permissions-db.ts', () => ({
	getUserRolesAndPermissions: (...args: Array<unknown>) =>
		mockModule.getUserRolesAndPermissions(...args),
}))

const { buildMcpUserContextFromGrantProps } =
	await import('./mcp-auth-user-context.ts')

type GrantUserRow = {
	id: number
	email: string
	username: string | null
	display_name: string | null
	stable_user_id: string
}

function createMockAppDb(options: {
	row?: GrantUserRow | null
	reject?: Error
}) {
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql, params })
					return {
						async first<T>() {
							if (options.reject) throw options.reject
							const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
							if (
								normalized.includes('where stable_user_id = ?') &&
								normalized.includes('select id')
							) {
								return (options.row ?? null) as T | null
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

test('buildMcpUserContextFromGrantProps resolves by stable id, refreshes profile, and fails closed', async () => {
	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	const refreshed = createMockAppDb({
		row: {
			id: 42,
			email: 'current@example.com',
			username: 'admin',
			display_name: 'Admin Display',
			stable_user_id: 'stable-admin-id',
		},
	})

	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: refreshed.db } as Env, {
			userId: 'stable-admin-id',
			email: 'stale@example.com',
			username: 'stale-username',
			displayName: 'stale display',
		}),
	).resolves.toEqual({
		userId: 'stable-admin-id',
		email: 'current@example.com',
		username: 'admin',
		displayName: 'Admin Display',
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	expect(refreshed.queries).toHaveLength(1)
	expect(refreshed.queries[0]?.params).toEqual(['stable-admin-id'])
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledWith(
		refreshed.db,
		42,
	)

	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['user'],
		permissions: [],
	})
	const staleEmailOwnedElsewhere = createMockAppDb({
		row: {
			id: 7,
			email: 'original-owner@example.com',
			username: 'original',
			display_name: null,
			stable_user_id: 'stable-original',
		},
	})
	await expect(
		buildMcpUserContextFromGrantProps(
			{ APP_DB: staleEmailOwnedElsewhere.db } as Env,
			{
				userId: 'stable-original',
				// Email now belongs to a different verified admin account.
				email: 'reused-by-admin@example.com',
				displayName: 'stale',
			},
		),
	).resolves.toEqual({
		userId: 'stable-original',
		email: 'original-owner@example.com',
		username: 'original',
		displayName: 'original',
		roles: ['user'],
		permissions: [],
	})
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledWith(
		staleEmailOwnedElsewhere.db,
		7,
	)

	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['user'],
		permissions: [],
	})
	const emailOmitted = createMockAppDb({
		row: {
			id: 9,
			email: 'resolved@example.com',
			username: 'resolved',
			display_name: null,
			stable_user_id: 'legacy-id',
		},
	})
	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: emailOmitted.db } as Env, {
			userId: 'legacy-id',
		}),
	).resolves.toEqual({
		userId: 'legacy-id',
		email: 'resolved@example.com',
		username: 'resolved',
		displayName: 'resolved',
		roles: ['user'],
		permissions: [],
	})
	expect(emailOmitted.queries[0]?.params).toEqual(['legacy-id'])

	const missingRow = createMockAppDb({ row: null })
	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: missingRow.db } as Env, {
			userId: 'orphan-id',
			email: 'missing@example.com',
			displayName: 'missing',
		}),
	).resolves.toEqual({
		userId: 'orphan-id',
		email: 'missing@example.com',
		displayName: 'missing',
	})
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledTimes(3)

	consoleError.mockImplementation(() => {})
	const failingDb = createMockAppDb({
		reject: new Error('D1 unavailable'),
	})
	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: failingDb.db } as Env, {
			userId: 'resilient-id',
			email: 'resilient@example.com',
			displayName: 'resilient',
		}),
	).resolves.toEqual({
		userId: 'resilient-id',
		email: 'resilient@example.com',
		displayName: 'resilient',
	})
	expect(consoleError).toHaveBeenCalled()
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledTimes(3)
})
