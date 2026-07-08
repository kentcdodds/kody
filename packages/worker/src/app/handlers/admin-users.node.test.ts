import { expect, test, vi } from 'vitest'
import { adminUserListItemFieldNames } from './admin-users.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	logAuditEvent: vi.fn(async () => undefined),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/audit-log.ts', () => ({
	getRequestIp: () => '127.0.0.1',
	logAuditEvent: (...args: Array<unknown>) => mockModule.logAuditEvent(...args),
}))

type UserRow = {
	id: number
	username: string
	email: string
	email_verified_at?: string | null
	plan?: string | null
	created_at: string
	updated_at: string
}

type UserRoleRow = { user_id: number; role_name: RoleName }

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: 'stable-admin',
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createAdminTestEnv(input: {
	users: Array<UserRow>
	userRoles: Array<UserRoleRow>
}) {
	const users = new Map(input.users.map((user) => [user.id, { ...user }]))
	const userRoles = input.userRoles.map((row) => ({ ...row }))

	return {
		COOKIE_SECRET: 'secret',
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const execute = {
					async all<T>() {
						if (
							normalizedQuery.includes('select count(*) as total from users')
						) {
							return {
								results: [{ total: users.size }] as Array<T>,
								meta: { changes: 0 },
							}
						}
						return { results: [] as Array<T>, meta: { changes: 0 } }
					},
					async first<T>() {
						if (
							normalizedQuery.includes('select count(*) as total from users')
						) {
							return { total: users.size } as T
						}
						return null
					},
					async run() {
						return { meta: { changes: 0 } }
					},
				}
				return {
					...execute,
					bind(...params: Array<unknown>) {
						return {
							async all<T>() {
								if (normalizedQuery.startsWith('select id, username, email')) {
									const pageSize = Number(params[0])
									const offset = Number(params[1])
									const results = Array.from(users.values())
										.sort((a, b) => a.id - b.id)
										.slice(offset, offset + pageSize)
									return { results: results as Array<T>, meta: { changes: 0 } }
								}
								if (normalizedQuery.includes('where ur.user_id in')) {
									const userIds = params.map((value) => Number(value))
									return {
										results: userRoles
											.filter((row) => userIds.includes(row.user_id))
											.map((row) => ({
												user_id: row.user_id,
												role_name: row.role_name,
											})) as Array<T>,
										meta: { changes: 0 },
									}
								}
								return { results: [] as Array<T>, meta: { changes: 0 } }
							},
							async first<T>() {
								if (
									normalizedQuery.includes(
										'select id, email from users where id =',
									)
								) {
									const user = users.get(Number(params[0]))
									return user ? ({ id: user.id, email: user.email } as T) : null
								}
								if (
									normalizedQuery.includes(
										'select id, username, email, email_verified_at, plan, created_at, updated_at from users where id =',
									)
								) {
									const user = users.get(Number(params[0]))
									return user ? ({ ...user } as T) : null
								}
								if (
									normalizedQuery.includes(
										'count(distinct ur.user_id) as count',
									)
								) {
									const roleName = String(params[0])
									const count = new Set(
										userRoles
											.filter((row) => row.role_name === roleName)
											.map((row) => row.user_id),
									).size
									return { count } as T
								}
								return null
							},
							async run() {
								if (
									normalizedQuery.includes('insert or ignore into user_roles')
								) {
									const userId = Number(params[0])
									const roleName = String(params[1]) as RoleName
									if (
										!userRoles.some(
											(row) =>
												row.user_id === userId && row.role_name === roleName,
										)
									) {
										userRoles.push({ user_id: userId, role_name: roleName })
									}
									return { meta: { changes: 1 } }
								}
								if (
									normalizedQuery.includes('delete from user_roles') &&
									normalizedQuery.includes('count(distinct ur.user_id)')
								) {
									// Atomic admin removal: only deletes while another admin
									// remains, mirroring removeAdminRolePreservingLastAdmin.
									const userId = Number(params[0])
									const adminCount = new Set(
										userRoles
											.filter((row) => row.role_name === 'admin')
											.map((row) => row.user_id),
									).size
									const index = userRoles.findIndex(
										(row) =>
											row.user_id === userId && row.role_name === 'admin',
									)
									if (adminCount > 1 && index >= 0) {
										userRoles.splice(index, 1)
										return { meta: { changes: 1 } }
									}
									return { meta: { changes: 0 } }
								}
								if (normalizedQuery.includes('delete from user_roles')) {
									const userId = Number(params[0])
									const roleName = String(params[1]) as RoleName
									const index = userRoles.findIndex(
										(row) =>
											row.user_id === userId && row.role_name === roleName,
									)
									if (index >= 0) userRoles.splice(index, 1)
									return { meta: { changes: 1 } }
								}
								if (
									normalizedQuery.includes(
										'update users set plan = ?, updated_at = ? where id =',
									)
								) {
									const user = users.get(Number(params[2]))
									if (!user) return { meta: { changes: 0 } }
									user.plan = params[0] === null ? null : String(params[0])
									user.updated_at = String(params[1])
									return { meta: { changes: 1 } }
								}
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
	}
}

const { createAdminUsersApiHandler } = await import('./admin-users.ts')

test('admin users list payload exposes only account metadata fields', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'admin-user',
				email: 'admin@example.com',
				email_verified_at: '2026-01-01T00:00:00.000Z',
				plan: 'pro',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				email_verified_at: null,
				plan: 'not-a-real-plan',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
		],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(Object.keys(payload).sort()).toEqual(
		[
			'availablePlans',
			'availableRoles',
			'ok',
			'page',
			'pageSize',
			'total',
			'users',
		].sort(),
	)
	for (const user of payload.users) {
		expect(Object.keys(user).sort()).toEqual(
			[...adminUserListItemFieldNames].sort(),
		)
	}
	expect(payload.users).toEqual([
		expect.objectContaining({
			email: 'admin@example.com',
			email_verified: true,
			email_verified_at: '2026-01-01T00:00:00.000Z',
			plan: 'pro',
		}),
		expect.objectContaining({
			email: 'member@example.com',
			email_verified: false,
			email_verified_at: null,
			// Unknown stored plan values read back as null (legacy/unlimited).
			plan: null,
		}),
	])
})

test('assign role action updates user roles and logs audit event', async () => {
	mockModule.logAuditEvent.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'assign_role',
				userId: 2,
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.users[0].roles).toContain('admin')
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({ category: 'admin', action: 'assign_role' }),
	)
})

test('remove role rejects removing the last admin account', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'solo-admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'remove_role',
				userId: 1,
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(409)
})

test('remove role removes admin when another admin remains', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'first-admin',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'second-admin',
				email: 'second@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
		],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'remove_role',
				userId: 2,
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	const secondAdmin = payload.users.find(
		(user: { id: number }) => user.id === 2,
	)
	expect(secondAdmin.roles).not.toContain('admin')
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'remove_role',
			result: 'success',
		}),
	)
})

test('update plan action sets the plan and logs an audit event', async () => {
	mockModule.logAuditEvent.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				plan: null,
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'update_plan',
				userId: 2,
				plan: 'personal',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.users[0].plan).toBe('personal')
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'update_plan',
			result: 'success',
			reason: 'target_user_id=2;plan=personal',
		}),
	)
})

test('update plan action clears the plan with explicit null', async () => {
	mockModule.logAuditEvent.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				plan: 'pro',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})

	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ action: 'update_plan', userId: 2, plan: null }),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.users[0].plan).toBe(null)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'update_plan',
			result: 'success',
			reason: 'target_user_id=2;plan=null',
		}),
	)
})

test('update plan action rejects unknown plan values and missing plan key', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				plan: 'pro',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)

	for (const body of [
		{ action: 'update_plan', userId: 2, plan: 'enterprise' },
		{ action: 'update_plan', userId: 2 },
	]) {
		const response = await handler.handler({
			request: new Request('https://example.com/admin/users.json', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			}),
			params: {},
			url: new URL('https://example.com/admin/users.json'),
		} as never)
		expect(response.status).toBe(400)
	}
})

test('update plan action returns 404 for an unknown user', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({ users: [], userRoles: [] })
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ action: 'update_plan', userId: 42, plan: 'pro' }),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)
	expect(response.status).toBe(404)
})

test('admin users API returns 403 without read:user:any permission', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const env = createAdminTestEnv({ users: [], userRoles: [] })
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/users.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)
	expect(response.status).toBe(403)
})
