import { expect, test } from 'vitest'
import {
	createDefaultMcpCallerContext,
	createMcpCallerContext,
	getDefaultMcpRemoteConnectorRefs,
	parseMcpCallerContext,
} from './context.ts'

test('createMcpCallerContext normalizes missing user to null', () => {
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
})

test('createDefaultMcpCallerContext attaches the default home remote connector', () => {
	expect(
		createDefaultMcpCallerContext({
			baseUrl: 'https://heykody.dev',
		}),
	).toMatchObject({
		baseUrl: 'https://heykody.dev',
		remoteConnectors: [{ kind: 'home', instanceId: 'default' }],
		user: null,
	})
})

test('createDefaultMcpCallerContext preserves explicit remote connector refs', () => {
	expect(
		createDefaultMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			remoteConnectors: [{ kind: 'lights', instanceId: 'living-room' }],
		}).remoteConnectors,
	).toEqual([{ kind: 'lights', instanceId: 'living-room' }])

	expect(
		createDefaultMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			remoteConnectors: null,
		}).remoteConnectors,
	).toBeNull()
})

test('getDefaultMcpRemoteConnectorRefs returns a fresh ref list', () => {
	const first = getDefaultMcpRemoteConnectorRefs()
	const second = getDefaultMcpRemoteConnectorRefs()

	expect(first).toEqual([{ kind: 'home', instanceId: 'default' }])
	expect(first).not.toBe(second)
	expect(first[0]).not.toBe(second[0])
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
	expect(parsed.remoteConnectors ?? null).toBeNull()
	expect(parsed.repoContext ?? null).toBeNull()
})
