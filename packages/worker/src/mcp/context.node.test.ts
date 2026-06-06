import { expect, test } from 'vitest'
import { createMcpCallerContext, parseMcpCallerContext } from './context.ts'

test('MCP caller context helpers normalize optional fields and validate parsed shapes', () => {
	expect(
		createMcpCallerContext({
			baseUrl: 'https://example.com',
		}),
	).toEqual({
		baseUrl: 'https://example.com',
		remoteConnectors: null,
		repoContext: null,
		storageContext: null,
		user: null,
	})

	const parsed = parseMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: '123',
			email: 'user@example.com',
			displayName: 'user',
		},
		storageContext: {
			sessionId: 'session-123',
			appId: 'app-123',
		},
	})
	expect(parsed).toMatchObject({
		baseUrl: 'https://example.com',
		user: {
			userId: '123',
			email: 'user@example.com',
			displayName: 'user',
		},
		storageContext: {
			sessionId: 'session-123',
			appId: 'app-123',
		},
	})
	expect(parsed.remoteConnectors ?? null).toBeNull()
	expect(parsed.repoContext ?? null).toBeNull()
})
