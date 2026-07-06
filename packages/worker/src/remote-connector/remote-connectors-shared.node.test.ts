import { expect, test } from 'vitest'
import {
	normalizeRemoteConnectorRefs,
	userScopedConnectorWebSocketUrl,
} from '@kody-internal/shared/remote-connectors.ts'

test('normalizeRemoteConnectorRefs trims and lowercases instance ids', () => {
	expect(
		normalizeRemoteConnectorRefs({
			remoteConnectors: [{ instanceId: '  Home  ' }, { instanceId: 'x' }],
		}),
	).toEqual([{ instanceId: 'home' }, { instanceId: 'x' }])
})

test('userScopedConnectorWebSocketUrl builds user-scoped connector URLs', () => {
	expect(
		userScopedConnectorWebSocketUrl({
			origin: 'wss://kody.example.com',
			username: 'user-aaa',
			instanceId: 'living room',
		}),
	).toBe('wss://kody.example.com/@user-aaa/connectors/living%20room')
})
