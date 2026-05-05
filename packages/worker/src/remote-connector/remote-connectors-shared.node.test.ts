import { expect, test } from 'vitest'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'

test('normalizeRemoteConnectorRefs maps homeConnectorId when remoteConnectors unset', () => {
	expect(
		normalizeRemoteConnectorRefs({
			homeConnectorId: 'living-room',
			remoteConnectors: undefined,
		}),
	).toEqual([{ kind: 'home', instanceId: 'living-room', trusted: true }])
})

test('normalizeRemoteConnectorRefs uses remoteConnectors when provided', () => {
	expect(
		normalizeRemoteConnectorRefs({
			homeConnectorId: 'ignored',
			remoteConnectors: [
				{ kind: 'Home', instanceId: '  a  ' },
				{ kind: 'custom', instanceId: 'x', trusted: true },
				{ kind: 'other', instanceId: 'y' },
			],
		}),
	).toEqual([
		{ kind: 'home', instanceId: 'a', trusted: true },
		{ kind: 'custom', instanceId: 'x', trusted: true },
		{ kind: 'other', instanceId: 'y', trusted: false },
	])
})

test('normalizeRemoteConnectorRefs empty array does not fall back to homeConnectorId', () => {
	expect(
		normalizeRemoteConnectorRefs({
			homeConnectorId: 'living-room',
			remoteConnectors: [],
		}),
	).toEqual([])
})
