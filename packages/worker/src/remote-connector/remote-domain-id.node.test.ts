import { expect, test } from 'vitest'
import {
	remoteConnectorCapabilityId,
	remoteConnectorCodemodeName,
	remoteConnectorDomainId,
	remoteConnectorToolName,
} from './remote-domain-id.ts'

test('remote connector ids keep clean names readable', () => {
	const ref = { kind: 'home', instanceId: 'default' }

	expect(remoteConnectorDomainId(ref)).toBe('remote:home:default')
	expect(remoteConnectorCodemodeName(ref)).toBe('home/default')
	expect(remoteConnectorToolName('set_pin')).toBe('set_pin')
	expect(remoteConnectorCapabilityId({ ref, toolName: 'set_pin' })).toBe(
		'remote:home/default:set_pin',
	)
})

test('remote connector ids disambiguate names that sanitize to the same slug', () => {
	const spacedRef = { kind: 'home', instanceId: 'living room' }
	const underscoredRef = { kind: 'home', instanceId: 'living_room' }
	const spacedTool = remoteConnectorToolName('set pin')
	const underscoredTool = remoteConnectorToolName('set_pin')

	expect(remoteConnectorCodemodeName(spacedRef)).toMatch(
		/^home\/living_room_[0-9a-f]{8}$/,
	)
	expect(remoteConnectorCodemodeName(underscoredRef)).toBe('home/living_room')
	expect(spacedTool).toMatch(/^set_pin_[0-9a-f]{8}$/)
	expect(underscoredTool).toBe('set_pin')
	expect(remoteConnectorCodemodeName(spacedRef)).not.toBe(
		remoteConnectorCodemodeName(underscoredRef),
	)
	expect(spacedTool).not.toBe(underscoredTool)
})
