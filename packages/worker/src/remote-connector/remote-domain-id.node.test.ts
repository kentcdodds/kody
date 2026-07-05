import { expect, test } from 'vitest'
import {
	remoteConnectorCapabilityId,
	remoteConnectorKodyName,
	remoteConnectorDomainId,
	remoteConnectorToolName,
} from './remote-domain-id.ts'

test('remote connector ids keep clean names readable', () => {
	const ref = { kind: 'home', instanceId: 'home' }

	expect(remoteConnectorDomainId(ref)).toBe('remote:home')
	expect(remoteConnectorKodyName(ref)).toBe('home')
	expect(remoteConnectorToolName('set_pin')).toBe('set_pin')
	expect(remoteConnectorCapabilityId({ ref, toolName: 'set_pin' })).toBe(
		'remote:home:set_pin',
	)
})

test('remote connector ids disambiguate names that sanitize to the same slug', () => {
	const spacedRef = { kind: 'home', instanceId: 'living room' }
	const underscoredRef = { kind: 'home', instanceId: 'living_room' }
	const spacedTool = remoteConnectorToolName('set pin')
	const underscoredTool = remoteConnectorToolName('set_pin')

	expect(remoteConnectorKodyName(spacedRef)).toMatch(
		/^living_room_[0-9a-f]{8}$/,
	)
	expect(remoteConnectorKodyName(underscoredRef)).toBe('living_room')
	expect(spacedTool).toMatch(/^set_pin_[0-9a-f]{8}$/)
	expect(underscoredTool).toBe('set_pin')
	expect(remoteConnectorKodyName(spacedRef)).not.toBe(
		remoteConnectorKodyName(underscoredRef),
	)
	expect(spacedTool).not.toBe(underscoredTool)
})
