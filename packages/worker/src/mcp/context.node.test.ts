import { expect, test } from 'vitest'
import { createMcpCallerContext, parseMcpCallerContext } from './context.ts'

test('createMcpCallerContext normalizes missing user to null', () => {
	expect(
		createMcpCallerContext({
			baseUrl: 'https://example.com',
		}),
	).toEqual({
		baseUrl: 'https://example.com',
		homeConnectorId: null,
		storageContext: null,
		user: null,
	})
})

test('parseMcpCallerContext validates caller context shape', () => {
	expect(
		parseMcpCallerContext({
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
		}),
	).toEqual({
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
})
