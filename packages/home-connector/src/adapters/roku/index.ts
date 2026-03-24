import {
	adoptRokuDevice,
	getAdoptedRokuDevices,
	getDiscoveredRokuDevices,
	ignoreRokuDevice,
	updateDiscoveredRokuDevices,
} from './devices/repository.ts'
import { discoverRokuDevices } from './discovery/client.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { type RokuDiscoveredDevice } from './types.ts'

function createDeviceId(input: RokuDiscoveredDevice) {
	const base = input.serialNumber || input.location || input.id || input.name
	return `roku-${base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

export async function scanRokuDevices(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const discovered = await discoverRokuDevices({
		discoveryUrl: config.rokuDiscoveryUrl,
	})
	const now = new Date().toISOString()
	const normalized = discovered.map((device) => ({
		...device,
		deviceId: createDeviceId(device),
		lastSeenAt: now,
		adopted: device.isAdopted,
	}))
	updateDiscoveredRokuDevices(state, normalized)
	return normalized
}

export function getRokuStatus(state: HomeConnectorState) {
	return {
		discovered: getDiscoveredRokuDevices(state),
		adopted: getAdoptedRokuDevices(state),
	}
}

export function adoptRoku(state: HomeConnectorState, deviceId: string) {
	const adopted = adoptRokuDevice(state, deviceId)
	if (!adopted) {
		throw new Error(`Roku device "${deviceId}" was not found.`)
	}
	return adopted
}

export function ignoreRoku(state: HomeConnectorState, deviceId: string) {
	ignoreRokuDevice(state, deviceId)
}
