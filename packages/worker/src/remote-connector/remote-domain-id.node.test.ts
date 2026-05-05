import { expect, test } from 'vitest'
import {
	remoteConnectorCapabilityPrefix,
	remoteConnectorDomainId,
} from './remote-domain-id.ts'

test('remote connector domain ids slug instance ids and preserve kind', () => {
	expect(
		remoteConnectorDomainId({
			kind: 'calendar',
			instanceId: 'Work Calendar!',
			trusted: true,
		}),
	).toBe('remote:calendar:Work_Calendar')
})

test('capability prefix keeps only default home connector on legacy prefix', () => {
	const ref = { kind: 'home', instanceId: 'default', trusted: true }

	expect(remoteConnectorCapabilityPrefix(ref, [ref])).toBe('home')
	expect(
		remoteConnectorCapabilityPrefix(ref, [
			ref,
			{ kind: 'calendar', instanceId: 'work', trusted: true },
		]),
	).toBe('home_default')
})

test('capability prefix scopes generic connectors by kind and instance', () => {
	expect(
		remoteConnectorCapabilityPrefix(
			{ kind: 'calendar', instanceId: 'Work Calendar!', trusted: true },
			[{ kind: 'calendar', instanceId: 'Work Calendar!', trusted: true }],
		),
	).toBe('calendar_Work_Calendar')
})
