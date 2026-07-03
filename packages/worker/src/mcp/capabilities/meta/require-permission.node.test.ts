import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { requireMcpUserWithPermission } from './require-permission.ts'

test('requireMcpUserWithPermission requires an authenticated user', () => {
	expect(() =>
		requireMcpUserWithPermission(
			createMcpCallerContext({ baseUrl: 'https://example.com' }),
			'read:user:any',
		),
	).toThrow('Authenticated MCP user is required for this capability.')
})

test('requireMcpUserWithPermission throws when the user lacks the permission', () => {
	expect(() =>
		requireMcpUserWithPermission(
			createMcpCallerContext({
				baseUrl: 'https://example.com',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'user',
					roles: ['user'],
					permissions: ['read:user:own'],
				},
			}),
			'read:user:any',
		),
	).toThrow('MCP user lacks required permission: read:user:any')
})

test('requireMcpUserWithPermission returns the user when the permission is present', () => {
	const user = {
		userId: 'user-1',
		email: 'admin@example.com',
		displayName: 'admin',
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	}
	expect(
		requireMcpUserWithPermission(
			createMcpCallerContext({
				baseUrl: 'https://example.com',
				user,
			}),
			'read:user:any',
		),
	).toEqual(user)
})

test('requireMcpUserWithPermission treats missing permissions as unauthorized', () => {
	expect(() =>
		requireMcpUserWithPermission(
			createMcpCallerContext({
				baseUrl: 'https://example.com',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'user',
				},
			}),
			'read:user:any',
		),
	).toThrow('MCP user lacks required permission: read:user:any')
})
