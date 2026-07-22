import { expect, test, vi } from 'vitest'

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

test('buildMcpUserContextFromGrantProps loads roles by stable id and refreshes profile fields', async () => {
	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	const { db, queries } = createMockAppDb({
		row: {
			id: 42,
			email: 'current@example.com',
			username: 'admin',
			display_name: 'Admin Display',
			stable_user_id: 'stable-admin-id',
		},
	})

	const user = await buildMcpUserContextFromGrantProps({ APP_DB: db } as Env, {
		userId: 'stable-admin-id',
		email: 'stale@example.com',
		username: 'stale-username',
		displayName: 'stale display',
	})

	expect(user).toEqual({
		userId: 'stable-admin-id',
		email: 'current@example.com',
		username: 'admin',
		displayName: 'Admin Display',
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	expect(queries).toHaveLength(1)
	expect(queries[0]?.sql.toLowerCase()).toContain('where stable_user_id = ?')
	expect(queries[0]?.params).toEqual(['stable-admin-id'])
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledWith(db, 42)
})

test('buildMcpUserContextFromGrantProps never attaches roles from a stale grant email owned by another account', async () => {
	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['user'],
		permissions: [],
	})
	const { db } = createMockAppDb({
		row: {
			id: 7,
			email: 'original-owner@example.com',
			username: 'original',
			display_name: null,
			stable_user_id: 'stable-original',
		},
	})

	const user = await buildMcpUserContextFromGrantProps({ APP_DB: db } as Env, {
		userId: 'stable-original',
		// Email now belongs to a different verified admin account.
		email: 'reused-by-admin@example.com',
		displayName: 'stale',
	})

	expect(user).toEqual({
		userId: 'stable-original',
		email: 'original-owner@example.com',
		username: 'original',
		displayName: 'original',
		roles: ['user'],
		permissions: [],
	})
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledWith(db, 7)
})

test('buildMcpUserContextFromGrantProps omits roles when the stable id row is missing', async () => {
	const { db } = createMockAppDb({ row: null })

	const user = await buildMcpUserContextFromGrantProps({ APP_DB: db } as Env, {
		userId: 'orphan-id',
		email: 'missing@example.com',
		displayName: 'missing',
	})

	expect(user).toEqual({
		userId: 'orphan-id',
		email: 'missing@example.com',
		displayName: 'missing',
	})
	expect(mockModule.getUserRolesAndPermissions).not.toHaveBeenCalled()
})

test('buildMcpUserContextFromGrantProps falls back without elevation when D1 fails', async () => {
	const { db } = createMockAppDb({
		reject: new Error('D1 unavailable'),
	})
	const consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => undefined)

	try {
		const user = await buildMcpUserContextFromGrantProps(
			{ APP_DB: db } as Env,
			{
				userId: 'resilient-id',
				email: 'resilient@example.com',
				displayName: 'resilient',
			},
		)

		expect(user).toEqual({
			userId: 'resilient-id',
			email: 'resilient@example.com',
			displayName: 'resilient',
		})
		expect(consoleError).toHaveBeenCalled()
		expect(mockModule.getUserRolesAndPermissions).not.toHaveBeenCalled()
	} finally {
		consoleError.mockRestore()
	}
})

test('buildMcpUserContextFromGrantProps resolves by stable id when grant props omit email', async () => {
	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['user'],
		permissions: [],
	})
	const { db, queries } = createMockAppDb({
		row: {
			id: 9,
			email: 'resolved@example.com',
			username: 'resolved',
			display_name: null,
			stable_user_id: 'legacy-id',
		},
	})

	const user = await buildMcpUserContextFromGrantProps({ APP_DB: db } as Env, {
		userId: 'legacy-id',
	})

	expect(user).toEqual({
		userId: 'legacy-id',
		email: 'resolved@example.com',
		username: 'resolved',
		displayName: 'resolved',
		roles: ['user'],
		permissions: [],
	})
	expect(queries[0]?.params).toEqual(['legacy-id'])
})
