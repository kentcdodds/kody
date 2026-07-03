import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getUserRolesAndPermissions: vi.fn(),
	findOne: vi.fn(),
}))

vi.mock('#app/permissions-db.ts', () => ({
	getUserRolesAndPermissions: (...args: Array<unknown>) =>
		mockModule.getUserRolesAndPermissions(...args),
}))

vi.mock('#worker/db.ts', () => ({
	createDb: () => ({
		findOne: (...args: Array<unknown>) => mockModule.findOne(...args),
	}),
	usersTable: {},
}))

const { buildMcpUserContextFromGrantProps } =
	await import('./mcp-auth-user-context.ts')

function createMockAppDb() {
	return {
		prepare: () => ({
			bind: () => ({
				all: async () => ({ results: [], meta: { changes: 0 } }),
			}),
		}),
	} as unknown as D1Database
}

test('buildMcpUserContextFromGrantProps loads fresh roles and permissions', async () => {
	mockModule.findOne.mockResolvedValueOnce({
		id: 42,
		email: 'admin@example.com',
		username: 'admin',
	})
	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})

	const user = await buildMcpUserContextFromGrantProps(
		{ APP_DB: createMockAppDb() } as Env,
		{
			userId: 'stable-admin-id',
			email: 'admin@example.com',
			username: 'admin',
			displayName: 'admin',
		},
	)

	expect(user).toEqual({
		userId: 'stable-admin-id',
		email: 'admin@example.com',
		username: 'admin',
		displayName: 'admin',
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledWith(
		expect.anything(),
		42,
	)
})

test('buildMcpUserContextFromGrantProps omits roles and permissions when the users row is missing', async () => {
	mockModule.findOne.mockResolvedValueOnce(null)

	const user = await buildMcpUserContextFromGrantProps(
		{ APP_DB: createMockAppDb() } as Env,
		{
			userId: 'orphan-id',
			email: 'missing@example.com',
			displayName: 'missing',
		},
	)

	expect(user).toEqual({
		userId: 'orphan-id',
		email: 'missing@example.com',
		displayName: 'missing',
	})
	expect(mockModule.getUserRolesAndPermissions).not.toHaveBeenCalled()
})

test('buildMcpUserContextFromGrantProps falls back to the base user when the rbac lookup fails', async () => {
	mockModule.findOne.mockRejectedValueOnce(new Error('D1 unavailable'))
	const consoleError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => undefined)

	try {
		const user = await buildMcpUserContextFromGrantProps(
			{ APP_DB: createMockAppDb() } as Env,
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
	} finally {
		consoleError.mockRestore()
	}
})

test('buildMcpUserContextFromGrantProps skips rbac lookup when grant props omit email', async () => {
	const user = await buildMcpUserContextFromGrantProps(
		{ APP_DB: createMockAppDb() } as Env,
		{
			userId: 'legacy-id',
		},
	)

	expect(user).toEqual({
		userId: 'legacy-id',
		email: '',
		displayName: 'user',
	})
	expect(mockModule.findOne).not.toHaveBeenCalled()
	expect(mockModule.getUserRolesAndPermissions).not.toHaveBeenCalled()
})
