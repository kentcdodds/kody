import { expect, test } from 'vitest'
import {
	normalizeRemoteConnectorRefs,
	userScopedConnectorWebSocketUrl,
} from '@kody-internal/shared/remote-connectors.ts'

test('normalizeRemoteConnectorRefs normalizes connector lists and userScopedConnectorWebSocketUrl builds scoped URLs', () => {
	expect(
		normalizeRemoteConnectorRefs({
			remoteConnectors: undefined,
		}),
	).toEqual([])

	expect(
		normalizeRemoteConnectorRefs({
			remoteConnectors: [],
		}),
	).toEqual([])

	expect(
		normalizeRemoteConnectorRefs({
			remoteConnectors: [
				{ kind: 'Lights', instanceId: '  a  ' },
				{ kind: 'custom', instanceId: 'x' },
			],
		}),
	).toEqual([
		{ kind: 'lights', instanceId: 'a' },
		{ kind: 'custom', instanceId: 'x' },
	])

	expect(
		userScopedConnectorWebSocketUrl({
			origin: 'wss://kody.example.com/',
			username: 'user-aaa',
			kind: 'Lights',
			instanceId: 'living room',
		}),
	).toBe('wss://kody.example.com/@user-aaa/connectors/lights/living%20room')
})
