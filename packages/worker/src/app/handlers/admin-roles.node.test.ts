import { expect, test, vi } from 'vitest'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:role:any']
		: ['read:role:own']
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

function createRolesTestEnv() {
	const roles = [
		{ name: 'admin', description: 'Operator role' },
		{ name: 'user', description: 'Default role for every account' },
	]
	const permissions = [
		{ role_name: 'user', action: 'read', entity: 'user', access: 'own' },
		{ role_name: 'admin', action: 'read', entity: 'role', access: 'any' },
	]

	return {
		COOKIE_SECRET: 'secret',
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const execute = {
					async all<T>() {
						if (
							normalizedQuery.includes('select name, description from roles')
						) {
							return { results: roles as Array<T>, meta: { changes: 0 } }
						}
						if (
							normalizedQuery.includes('from roles r') &&
							normalizedQuery.includes('join role_permissions rp')
						) {
							return { results: permissions as Array<T>, meta: { changes: 0 } }
						}
						return { results: [] as Array<T>, meta: { changes: 0 } }
					},
					async first() {
						return null
					},
					async run() {
						return { meta: { changes: 0 } }
					},
				}
				return { ...execute, bind: () => execute }
			},
		} as unknown as D1Database,
	}
}

const { createAdminRolesApiHandler } = await import('./admin-roles.ts')

test('admin roles list returns roles and attached permissions', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['admin']),
	)
	const handler = createAdminRolesApiHandler(
		createRolesTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/roles.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/roles.json'),
	} as never)
	expect(response.status).toBe(200)
})

test('admin roles API returns 403 without read:role:any permission', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(['user']),
	)
	const handler = createAdminRolesApiHandler(
		createRolesTestEnv() as unknown as Env,
	)
	const response = await handler.handler({
		request: new Request('https://example.com/admin/roles.json', {
			headers: { Accept: 'application/json' },
		}),
		params: {},
		url: new URL('https://example.com/admin/roles.json'),
	} as never)
	expect(response.status).toBe(403)
})
