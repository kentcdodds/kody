import { expect, test } from 'vitest'
import { parseSafe } from 'remix/data-schema'
import { mcpCallerContextSchema, mcpUserContextSchema } from './chat.ts'

test('mcp context schemas accept valid user and caller payloads', () => {
	const userContext = parseSafe(mcpUserContextSchema, {
		userId: 'user-1',
		email: 'user@example.com',
		displayName: 'user',
		roles: ['user', 'admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	expect(userContext.success).toBe(true)
	if (userContext.success) {
		expect(userContext.value.userId).toBe('user-1')
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
