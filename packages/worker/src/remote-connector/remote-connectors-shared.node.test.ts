import { expect, test } from 'vitest'
import {
	normalizeRemoteConnectorRefs,
	userScopedConnectorWebSocketUrl,
} from '@kody-internal/shared/remote-connectors.ts'

test('normalizeRemoteConnectorRefs returns empty when remoteConnectors unset', () => {
	expect(
		normalizeRemoteConnectorRefs({
			remoteConnectors: undefined,
		}),
	).toEqual([])
})

test('normalizeRemoteConnectorRefs normalizes remoteConnectors when provided', () => {
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
})

test('normalizeRemoteConnectorRefs preserves an empty connector list', () => {
	expect(
		normalizeRemoteConnectorRefs({
			remoteConnectors: [],
		}),
	).toEqual([])
})

test('userScopedConnectorWebSocketUrl builds encoded user-scoped connector URLs', () => {
	expect(
		userScopedConnectorWebSocketUrl({
			origin: 'wss://kody.example.com/',
			userId: 'user aaa',
			kind: 'Lights',
			instanceId: 'living room',
		}),
	).toBe('wss://kody.example.com/connectors/u/user%20aaa/lights/living%20room')
})
