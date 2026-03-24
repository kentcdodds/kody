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
import { type RokuDeviceRecord, type RokuDiscoveredDevice } from './types.ts'

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

function getDeviceOrThrow(state: HomeConnectorState, deviceId: string) {
	const device =
		state.devices.find((entry) => entry.deviceId === deviceId) ?? null
	if (!device) {
		throw new Error(`Roku device "${deviceId}" was not found.`)
	}
	return device
}

function buildMockControlUrl(
	config: HomeConnectorConfig,
	deviceId: string,
	key: string,
) {
	const discoveryUrl = new URL(config.rokuDiscoveryUrl)
	discoveryUrl.pathname = `/control/${encodeURIComponent(deviceId)}/${encodeURIComponent(key)}`
	discoveryUrl.search = ''
	discoveryUrl.hash = ''
	return discoveryUrl.toString()
}

function buildDeviceControlUrl(device: RokuDeviceRecord, key: string) {
	return `${device.location.replace(/\/$/, '')}/keypress/${encodeURIComponent(key)}`
}

async function sendRokuKeypress(input: {
	config: HomeConnectorConfig
	device: RokuDeviceRecord
	key: string
}) {
	const targetUrl = input.config.mocksEnabled
		? buildMockControlUrl(input.config, input.device.deviceId, input.key)
		: buildDeviceControlUrl(input.device, input.key)
	const response = await fetch(targetUrl, {
		method: 'POST',
	})
	if (!response.ok) {
		throw new Error(`Roku keypress failed with status ${response.status}.`)
	}
	const responseText = await response.text()
	return {
		ok: true,
		deviceId: input.device.deviceId,
		key: input.key,
		responseText,
	}
}

export function createRokuAdapter(input: {
	state: HomeConnectorState
	config: HomeConnectorConfig
}) {
	return {
		async scan() {
			return scanRokuDevices(input.state, input.config)
		},
		getStatus() {
			const discovered = getDiscoveredRokuDevices(input.state)
			const adopted = getAdoptedRokuDevices(input.state)
			return {
				discovered,
				adopted,
				allDevices: [...adopted, ...discovered],
			}
		},
		adoptDevice(deviceId: string) {
			return adoptRoku(input.state, deviceId)
		},
		ignoreDevice(deviceId: string) {
			const device = getDeviceOrThrow(input.state, deviceId)
			ignoreRoku(input.state, deviceId)
			return device
		},
		async pressKey(deviceId: string, key: string) {
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return sendRokuKeypress({
				config: input.config,
				device,
				key,
			})
		},
	}
}
