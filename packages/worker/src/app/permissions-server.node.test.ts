import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import {
	assignUserRole,
	getUserRolesAndPermissions,
} from '#app/permissions-db.ts'
import {
	requireUserWithPermission,
	requireUserWithRole,
	userHasPermission,
	userHasRole,
} from '#app/permissions-server.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type RbacRow = {
	user_id: number
	role_id: number
	role_name: RoleName
	action: string
	entity: string
	access: string
}

function createRbacTestDb(initialRows: Array<RbacRow> = []) {
	const rows = initialRows.map((row) => ({ ...row }))
	let nextRoleId = Math.max(0, ...rows.map((row) => row.role_id)) + 1

	const roles = new Map<RoleName, number>([
		['user', 1],
		['admin', 2],
	])

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							if (
								normalizedQuery.includes('from user_roles ur') &&
								normalizedQuery.includes('join roles r')
							) {
								const userId = Number(params[0])
								const results = rows
									.filter((row) => row.user_id === userId)
									.map((row) => ({
										role_name: row.role_name,
										action: row.action,
										entity: row.entity,
										access: row.access,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (
								normalizedQuery.includes('insert or ignore into user_roles')
							) {
								const userId = Number(params[0])
								const roleName = String(params[1]) as RoleName
								const roleId = roles.get(roleName) ?? nextRoleId++
								if (!roles.has(roleName)) {
									roles.set(roleName, roleId)
								}
								const exists = rows.some(
									(row) => row.user_id === userId && row.role_name === roleName,
								)
								if (!exists) {
									for (const permission of rolePermissions(roleName)) {
										rows.push({
											user_id: userId,
											role_id: roleId,
											role_name: roleName,
											...permission,
										})
									}
								}
								return { meta: { changes: exists ? 0 : 1 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, rows }
}

function rolePermissions(roleName: RoleName) {
	const ownActions = ['create', 'read', 'update', 'delete'] as const
	const entities = ['user', 'role'] as const
	const permissions: Array<{
		action: string
		entity: string
		access: string
	}> = []
	for (const action of ownActions) {
		for (const entity of entities) {
			permissions.push({ action, entity, access: 'own' })
		}
	}
	if (roleName === 'admin') {
		for (const action of ownActions) {
			for (const entity of entities) {
				permissions.push({ action, entity, access: 'any' })
			}
		}
	}
	return permissions
}

function createAuthenticatedUserEnv(input: {
	userId: number
	email?: string
	username?: string
	roles: Array<RoleName>
}) {
	const email = input.email ?? 'user@example.com'
	const username = input.username ?? 'session-user'
	const users = new Map([
		[
			input.userId,
			{
				id: input.userId,
				email,
				username,
				password_hash: 'unused',
				stable_user_id: testStableUserIdFromEmail(email),
				created_at: new Date(0).toISOString(),
				updated_at: new Date(0).toISOString(),
			},
		],
	])
	const rbacRows = input.roles.flatMap((roleName) =>
		rolePermissions(roleName).map((permission) => ({
			user_id: input.userId,
			role_id: roleName === 'admin' ? 2 : 1,
			role_name: roleName,
			...permission,
		})),
	)

	return {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind(...params: Array<unknown>) {
						function execute(loadUserId: number) {
							return rbacRows
								.filter((row) => row.user_id === loadUserId)
								.map((row) => ({
									role_name: row.role_name,
									action: row.action,
									entity: row.entity,
									access: row.access,
								}))
						}
						return {
							async all<T>() {
								if (
									normalizedQuery.includes('from user_roles ur') &&
									normalizedQuery.includes('join roles r')
								) {
									return {
										results: execute(Number(params[0])) as Array<T>,
										meta: { changes: 0 },
									}
								}
								if (
									normalizedQuery.startsWith('select') &&
									normalizedQuery.includes('from "users"') &&
									/"id"\s*=/.test(normalizedQuery)
								) {
									const user = users.get(Number(params[0]))
									return {
										results: user ? [{ ...user }] : [],
										meta: { changes: 0 },
									}
								}
								return { results: [] as Array<T>, meta: { changes: 0 } }
							},
							async first<T>() {
								const result = await this.all<T>()
								return (result.results[0] ?? null) as T | null
							},
							async run() {
								return { meta: { changes: 0 } }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
	}
}

test('getUserRolesAndPermissions unions permissions across multiple roles', async () => {
	const { db } = createRbacTestDb([
		{
			user_id: 1,
			role_id: 1,
			role_name: 'user',
			action: 'read',
			entity: 'user',
			access: 'own',
		},
		{
			user_id: 1,
			role_id: 2,
			role_name: 'admin',
			action: 'read',
			entity: 'user',
			access: 'any',
		},
	])

	const result = await getUserRolesAndPermissions(db, 1)
	expect(result.roles).toEqual(['admin', 'user'])
	expect(result.permissions).toEqual(['read:user:any', 'read:user:own'])
})

test('getUserRolesAndPermissions returns empty arrays for users with no roles', async () => {
	const { db } = createRbacTestDb()
	const result = await getUserRolesAndPermissions(db, 99)
	expect(result).toEqual({ roles: [], permissions: [] })
})

test('userHasPermission and userHasRole perform pure membership checks', () => {
	const user = {
		roles: ['user', 'admin'] as Array<RoleName>,
		permissions: ['read:user:own', 'read:user:any'] as Array<PermissionString>,
	}
	expect(userHasPermission(user, 'read:user:any')).toBe(true)
	expect(userHasPermission(user, 'delete:role:any')).toBe(false)
	expect(userHasRole(user, 'admin')).toBe(true)
	expect(userHasRole(user, 'user')).toBe(true)
})

test('requireUserWithPermission and requireUserWithRole enforce auth and authorization', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		id: '1',
		email: 'user@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const authorizedEnv = createAuthenticatedUserEnv({
		userId: 1,
		roles: ['admin'],
	})
	const userOnlyEnv = createAuthenticatedUserEnv({
		userId: 1,
		roles: ['user'],
	})

	await expect(
		requireUserWithPermission(
			new Request('https://example.com/admin/users.json', {
				headers: {
					Accept: 'application/json',
					Cookie: cookie,
				},
			}),
			authorizedEnv as Env,
			'read:user:any',
		),
	).resolves.toMatchObject({ userId: 1, roles: ['admin'] })

	await expect(
		requireUserWithPermission(
			new Request('https://example.com/admin/users.json', {
				headers: {
					Accept: 'application/json',
					Cookie: cookie,
				},
			}),
			userOnlyEnv as Env,
			'read:user:any',
		),
	).rejects.toMatchObject({ status: 403 })

	const forbiddenHtmlResponse = await requireUserWithRole(
		new Request('https://example.com/admin/users', {
			headers: { Cookie: cookie },
		}),
		userOnlyEnv as Env,
		'admin',
	).catch((response) => response)
	expect(forbiddenHtmlResponse).toBeInstanceOf(Response)
	expect(forbiddenHtmlResponse.status).toBe(403)

	await expect(
		requireUserWithRole(
			new Request('https://example.com/admin/users.json', {
				headers: { Accept: 'application/json' },
			}),
			authorizedEnv as Env,
			'admin',
		),
	).rejects.toMatchObject({ status: 401 })

	const redirectResponse = await requireUserWithRole(
		new Request('https://example.com/admin/users'),
		authorizedEnv as Env,
		'admin',
	).catch((response) => response)
	expect(redirectResponse).toBeInstanceOf(Response)
	expect(redirectResponse.status).toBe(302)
	expect(redirectResponse.headers.get('Location')).toContain('/login')
})

test('assignUserRole inserts the requested role for a user', async () => {
	const { db, rows } = createRbacTestDb()
	await assignUserRole({ db, userId: 7, roleName: 'user' })
	expect(
		rows.some((row) => row.user_id === 7 && row.role_name === 'user'),
	).toBe(true)
})
