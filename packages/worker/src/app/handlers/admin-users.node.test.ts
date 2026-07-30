import { expect, test, vi } from 'vitest'
import { adminUserListItemFieldNames } from './admin-users.ts'
import {
	type PermissionString,
	type RoleName,
} from '#worker/identity/permissions.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import type * as AuditLog from '#worker/audit-log.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

// The shared audit-log-spy setup file routes logAuditEvent; this test also
// needs a deterministic request IP for its audit assertions.
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

type UserRow = {
	id: number
	stable_user_id?: string
	username: string
	email: string
	email_verified_at?: string | null
	plan?: string | null
	suspended_at?: string | null
	email_outbound_paused_at?: string | null
	created_at: string
	updated_at: string
}

type UserRoleRow = { user_id: number; role_name: RoleName }

function stableUserId(id: number) {
	return id.toString(16).padStart(64, '0')
}

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
			userId: stableUserId(1),
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
	const users = new Map(
		input.users.map((user) => [
			user.id,
			{
				...user,
				stable_user_id: user.stable_user_id ?? stableUserId(user.id),
				// Normal fixtures default to free; unknown/null stay
				// explicit so the dedicated stored-plan coercion test can warn.
				plan: user.plan === undefined ? 'free' : user.plan,
				suspended_at: user.suspended_at ?? null,
				email_outbound_paused_at: user.email_outbound_paused_at ?? null,
			},
		]),
	)
	const userRoles = input.userRoles.map((row) => ({ ...row }))

	return {
		COOKIE_SECRET: 'secret',
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				// Mirrors buildAdminUserListWhereClause: an optional
				// username/email LIKE pair followed by an optional role
				// membership param, shared by the page query and its COUNT.
				function applyListFilters(params: Array<unknown>) {
					let rows = Array.from(users.values()).sort((a, b) => a.id - b.id)
					let paramIndex = 0
					if (normalizedQuery.includes('username like ?')) {
						const pattern = String(params[paramIndex])
						paramIndex += 2
						const needle = pattern
							.slice(1, -1)
							.replace(/\\(.)/g, '$1')
							.toLowerCase()
						rows = rows.filter(
							(row) =>
								row.username.toLowerCase().includes(needle) ||
								row.email.toLowerCase().includes(needle),
						)
					}
					if (normalizedQuery.includes('where r.name = ?')) {
						const roleName = String(params[paramIndex])
						paramIndex += 1
						rows = rows.filter((row) =>
							userRoles.some(
								(role) =>
									role.user_id === row.id && role.role_name === roleName,
							),
						)
					}
					return { rows, paramIndex }
				}
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
								if (
									normalizedQuery.startsWith(
										'select id, stable_user_id, username, email',
									)
								) {
									const { rows, paramIndex } = applyListFilters(params)
									const pageSize = Number(params[paramIndex])
									const offset = Number(params[paramIndex + 1])
									const results = rows.slice(offset, offset + pageSize)
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
								if (
									normalizedQuery.startsWith(
										'select count(*) as total from users',
									)
								) {
									const { rows } = applyListFilters(params)
									return { total: rows.length } as T
								}
								if (
									normalizedQuery.includes(
										'select id, stable_user_id, username, email, email_verified_at, plan, suspended_at, email_outbound_paused_at, created_at, updated_at from users where stable_user_id =',
									)
								) {
									const user = Array.from(users.values()).find(
										(row) => row.stable_user_id === params[0],
									)
									return user ? ({ ...user } as T) : null
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
								if (
									normalizedQuery.includes(
										'update users set suspended_at = ?, updated_at = ? where id =',
									)
								) {
									const user = users.get(Number(params[2]))
									if (!user) return { meta: { changes: 0 } }
									user.suspended_at =
										params[0] === null ? null : String(params[0])
									user.updated_at = String(params[1])
									return { meta: { changes: 1 } }
								}
								if (
									normalizedQuery.includes(
										'update users set email_outbound_paused_at = null, updated_at = ? where id =',
									)
								) {
									const user = users.get(Number(params[1]))
									if (!user) return { meta: { changes: 0 } }
									user.email_outbound_paused_at = null
									user.updated_at = String(params[0])
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
				plan: 'free',
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
			'selectedUser',
			'total',
			'users',
		].sort(),
	)
	expect(payload.selectedUser).toBeNull()
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
			plan: 'free',
		}),
	])
})

test('admin users selected param resolves outside the current page and filter', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'admin-user',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
			{
				id: 3,
				username: 'another-member',
				email: 'another@example.com',
				created_at: '2026-01-05 00:00:00',
				updated_at: '2026-01-06 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
			{ user_id: 3, role_name: 'user' },
		],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const listUsers = async (search: string) => {
		const response = await handler.handler({
			request: new Request(`https://example.com/admin/users.json${search}`, {
				headers: { Accept: 'application/json' },
			}),
			params: {},
			url: new URL(`https://example.com/admin/users.json${search}`),
		} as never)
		expect(response.status).toBe(200)
		return response.json()
	}

	// Selected user on a later page is still returned for the detail pane.
	const paged = await listUsers(
		`?pageSize=1&page=1&selected=${stableUserId(3)}`,
	)
	expect(
		paged.users.map((user: { stableUserId: string }) => user.stableUserId),
	).toEqual([stableUserId(1)])
	expect(paged.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(3),
			username: 'another-member',
			email: 'another@example.com',
		}),
	)

	// Selected user excluded by the active role filter is still returned.
	const filtered = await listUsers(`?role=admin&selected=${stableUserId(2)}`)
	expect(
		filtered.users.map((user: { stableUserId: string }) => user.stableUserId),
	).toEqual([stableUserId(1)])
	expect(filtered.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			username: 'member',
		}),
	)

	const missing = await listUsers(`?selected=${stableUserId(99)}`)
	expect(missing.selectedUser).toBeNull()

	const invalid = await listUsers('?selected=123')
	expect(invalid.selectedUser).toBeNull()
})

test('admin users list applies q and role filters to the slice and total', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 1,
				username: 'admin-user',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-02 00:00:00',
			},
			{
				id: 2,
				username: 'searchable-member',
				email: 'member@example.com',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
			{
				id: 3,
				username: 'another-member',
				email: 'searchable@example.com',
				created_at: '2026-01-05 00:00:00',
				updated_at: '2026-01-06 00:00:00',
			},
		],
		userRoles: [
			{ user_id: 1, role_name: 'admin' },
			{ user_id: 2, role_name: 'user' },
			{ user_id: 3, role_name: 'user' },
		],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const listUsers = async (search: string) => {
		const response = await handler.handler({
			request: new Request(`https://example.com/admin/users.json${search}`, {
				headers: { Accept: 'application/json' },
			}),
			params: {},
			url: new URL(`https://example.com/admin/users.json${search}`),
		} as never)
		expect(response.status).toBe(200)
		return response.json()
	}

	// q matches username or email; total reflects the filtered set.
	const searchPayload = await listUsers('?q=searchable')
	expect(searchPayload.total).toBe(2)
	expect(
		searchPayload.users.map(
			(user: { stableUserId: string }) => user.stableUserId,
		),
	).toEqual([stableUserId(2), stableUserId(3)])

	const rolePayload = await listUsers('?role=admin')
	expect(rolePayload.total).toBe(1)
	expect(
		rolePayload.users.map(
			(user: { stableUserId: string }) => user.stableUserId,
		),
	).toEqual([stableUserId(1)])

	const combinedPayload = await listUsers('?q=searchable&role=admin')
	expect(combinedPayload.total).toBe(0)
	expect(combinedPayload.users).toEqual([])

	// Unknown role values are ignored rather than filtering everything out.
	const unknownRolePayload = await listUsers('?role=not-a-role')
	expect(unknownRolePayload.total).toBe(3)

	// Filters and pagination compose.
	const pagedPayload = await listUsers('?q=searchable&pageSize=1&page=2')
	expect(pagedPayload.total).toBe(2)
	expect(
		pagedPayload.users.map(
			(user: { stableUserId: string }) => user.stableUserId,
		),
	).toEqual([stableUserId(3)])
})

test('assign role action updates user roles and logs audit event', async () => {
	logAuditEventSpy.mockClear()
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
				stableUserId: stableUserId(2),
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload.users[0].roles).toContain('admin')
	// Mutations return the updated target so the client can patch it into
	// an infinite-scroll window without resetting to the first page.
	expect(payload.updatedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			roles: expect.arrayContaining(['admin', 'user']),
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
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
				stableUserId: stableUserId(1),
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
				stableUserId: stableUserId(2),
				role: 'admin',
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)

	expect(response.status).toBe(200)
	const payload = await response.json()
	const secondAdmin = payload.users.find(
		(user: { stableUserId: string }) => user.stableUserId === stableUserId(2),
	)
	expect(secondAdmin.roles).not.toContain('admin')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'remove_role',
			result: 'success',
		}),
	)
})

test('update plan action sets, maps null to free, validates, and scopes plan changes', async () => {
	logAuditEventSpy.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				plan: 'max',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const postUpdatePlan = (body: Record<string, unknown>) =>
		handler.handler({
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

	const setPlanResponse = await postUpdatePlan({
		action: 'update_plan',
		stableUserId: stableUserId(2),
		plan: 'pro',
	})
	expect(setPlanResponse.status).toBe(200)
	expect((await setPlanResponse.json()).users[0].plan).toBe('pro')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'update_plan',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)};plan=pro`,
		}),
	)

	const clearPlanResponse = await postUpdatePlan({
		action: 'update_plan',
		stableUserId: stableUserId(2),
		plan: null,
	})
	expect(clearPlanResponse.status).toBe(200)
	expect((await clearPlanResponse.json()).users[0].plan).toBe('free')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'update_plan',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)};plan=free`,
		}),
	)

	for (const body of [
		{
			action: 'update_plan',
			stableUserId: stableUserId(2),
			plan: 'enterprise',
		},
		{ action: 'update_plan', stableUserId: stableUserId(2) },
		{ action: 'update_plan', stableUserId: 2, plan: 'pro' },
	]) {
		expect((await postUpdatePlan(body)).status).toBe(400)
	}

	const missingUserResponse = await postUpdatePlan({
		action: 'update_plan',
		stableUserId: stableUserId(42),
		plan: 'pro',
	})
	expect(missingUserResponse.status).toBe(404)
})

test('suspend, unsuspend, and resume email actions update flags and log audit events', async () => {
	logAuditEventSpy.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const env = createAdminTestEnv({
		users: [
			{
				id: 2,
				username: 'member',
				email: 'member@example.com',
				email_outbound_paused_at: '2026-07-20T00:00:00.000Z',
				created_at: '2026-01-03 00:00:00',
				updated_at: '2026-01-04 00:00:00',
			},
		],
		userRoles: [{ user_id: 2, role_name: 'user' }],
	})
	const handler = createAdminUsersApiHandler(env as unknown as Env)
	const postAction = (body: Record<string, unknown>) =>
		handler.handler({
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

	const suspendResponse = await postAction({
		action: 'suspend_user',
		stableUserId: stableUserId(2),
	})
	expect(suspendResponse.status).toBe(200)
	const suspended = await suspendResponse.json()
	expect(suspended.users[0].suspended_at).toBeTruthy()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'suspend_user',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	const unsuspendResponse = await postAction({
		action: 'unsuspend_user',
		stableUserId: stableUserId(2),
	})
	expect(unsuspendResponse.status).toBe(200)
	expect((await unsuspendResponse.json()).users[0].suspended_at).toBeNull()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'unsuspend_user',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	const resumeResponse = await postAction({
		action: 'resume_email_outbound',
		stableUserId: stableUserId(2),
	})
	expect(resumeResponse.status).toBe(200)
	expect(
		(await resumeResponse.json()).users[0].email_outbound_paused_at,
	).toBeNull()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'resume_email_outbound',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId(2)}`,
		}),
	)

	// Admins cannot suspend their own account (actor id is 1).
	const selfSuspendEnv = createAdminTestEnv({
		users: [
			{
				id: 1,
				stable_user_id: stableUserId(1),
				username: 'admin-user',
				email: 'admin@example.com',
				created_at: '2026-01-01 00:00:00',
				updated_at: '2026-01-01 00:00:00',
			},
		],
		userRoles: [{ user_id: 1, role_name: 'admin' }],
	})
	const selfHandler = createAdminUsersApiHandler(
		selfSuspendEnv as unknown as Env,
	)
	const selfResponse = await selfHandler.handler({
		request: new Request('https://example.com/admin/users.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				action: 'suspend_user',
				stableUserId: stableUserId(1),
			}),
		}),
		params: {},
		url: new URL('https://example.com/admin/users.json'),
	} as never)
	expect(selfResponse.status).toBe(400)

	expect(
		(
			await postAction({
				action: 'suspend_user',
				stableUserId: stableUserId(42),
			})
		).status,
	).toBe(404)
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
