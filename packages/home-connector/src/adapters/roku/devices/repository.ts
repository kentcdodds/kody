import {
	getAdoptedRokuDevices as getAdoptedDevicesFromState,
	getDiscoveredRokuDevices as getDiscoveredDevicesFromState,
	setRokuDevices,
	type HomeConnectorState,
} from '../../../state.ts'
import { type RokuDeviceRecord } from '../types.ts'

export function getDiscoveredRokuDevices(state: HomeConnectorState) {
	return getDiscoveredDevicesFromState(state)
}

export function getAdoptedRokuDevices(state: HomeConnectorState) {
	return getAdoptedDevicesFromState(state)
}

export function updateDiscoveredRokuDevices(
	state: HomeConnectorState,
	devices: Array<RokuDeviceRecord>,
) {
	const adoptedDeviceIds = new Set(
		getAdoptedDevicesFromState(state).map((device) => device.deviceId),
	)
	const nextDevices = devices.map((device) => ({
		...device,
		adopted: adoptedDeviceIds.has(device.deviceId),
	}))
	setRokuDevices(state, nextDevices)
}

export function adoptRokuDevice(state: HomeConnectorState, deviceId: string) {
	const nextDevices = state.devices.map((device) =>
		device.deviceId === deviceId ? { ...device, adopted: true } : device,
	)
	const adoptedDevice =
		nextDevices.find((device) => device.deviceId === deviceId) ?? null
	if (!adoptedDevice) return null
	setRokuDevices(state, nextDevices)
	return adoptedDevice
}

export function ignoreRokuDevice(state: HomeConnectorState, deviceId: string) {
	setRokuDevices(
		state,
		state.devices.filter((device) => device.deviceId !== deviceId),
	)
}
