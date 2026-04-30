import { expect, test } from 'vitest'
import { createMcpCallerContext, parseMcpCallerContext } from './context.ts'

test('createMcpCallerContext normalizes missing user to null', () => {
	expect(
		createMcpCallerContext({
			baseUrl: 'https://example.com',
		}),
	).toEqual({
		baseUrl: 'https://example.com',
		capabilityRestrictions: null,
		homeConnectorId: null,
		remoteConnectors: null,
		repoContext: null,
		storageContext: null,
		user: null,
	})
})

test('parseMcpCallerContext validates caller context shape', () => {
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
	expect(parsed.homeConnectorId ?? null).toBeNull()
	expect(parsed.remoteConnectors ?? null).toBeNull()
	expect(parsed.repoContext ?? null).toBeNull()
})
