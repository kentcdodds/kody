import { expect, test } from 'vitest'
import { parseSafe } from 'remix/data-schema'
import { mcpCallerContextSchema, mcpUserContextSchema } from './chat.ts'

test('mcp user context schema accepts contexts with and without roles and permissions', () => {
	const withoutRbac = parseSafe(mcpUserContextSchema, {
		userId: 'user-1',
		email: 'user@example.com',
		displayName: 'user',
	})
	expect(withoutRbac.success).toBe(true)
	if (withoutRbac.success) {
		expect(withoutRbac.value.roles).toBeUndefined()
		expect(withoutRbac.value.permissions).toBeUndefined()
	}

	const withRbac = parseSafe(mcpUserContextSchema, {
		userId: 'user-1',
		email: 'user@example.com',
		displayName: 'user',
		roles: ['user', 'admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	expect(withRbac.success).toBe(true)
	if (withRbac.success) {
		expect(withRbac.value.roles).toEqual(['user', 'admin'])
		expect(withRbac.value.permissions).toEqual([
			'read:user:any',
			'read:role:any',
		])
	}

	const callerContext = parseSafe(mcpCallerContextSchema, {
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
	})
	expect(callerContext.success).toBe(true)
})
