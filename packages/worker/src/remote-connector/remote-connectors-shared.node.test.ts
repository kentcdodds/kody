import { expect, test } from 'vitest'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'

test('normalizeRemoteConnectorRefs maps homeConnectorId when remoteConnectors unset', () => {
	expect(
		normalizeRemoteConnectorRefs({
			homeConnectorId: 'living-room',
			remoteConnectors: undefined,
		}),
	).toEqual([{ kind: 'home', instanceId: 'living-room' }])
})

test('normalizeRemoteConnectorRefs uses remoteConnectors when provided', () => {
	expect(
		normalizeRemoteConnectorRefs({
			homeConnectorId: 'ignored',
			remoteConnectors: [
				{ kind: 'Home', instanceId: '  a  ' },
				{ kind: 'custom', instanceId: 'x' },
			],
		}),
	).toEqual([
		{ kind: 'home', instanceId: 'a' },
		{ kind: 'custom', instanceId: 'x' },
	])
})
