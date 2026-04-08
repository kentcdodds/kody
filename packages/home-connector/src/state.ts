import {
	type RokuDeviceRecord,
	type RokuDiscoveryDiagnostics,
} from './adapters/roku/types.ts'
import { type LutronDiscoveryDiagnostics } from './adapters/lutron/types.ts'
import { type SamsungTvDiscoveryDiagnostics } from './adapters/samsung-tv/types.ts'
import { type SonosDiscoveryDiagnostics } from './adapters/sonos/types.ts'

export type HomeConnectorConnectionState = {
	workerUrl: string
	connectorId: string
	connected: boolean
	lastSyncAt: string | null
	lastError: string | null
	sharedSecret: string | null
	mocksEnabled: boolean
}

export type HomeConnectorState = {
	connection: HomeConnectorConnectionState
	devices: Array<RokuDeviceRecord>
	rokuDiscoveryDiagnostics: RokuDiscoveryDiagnostics | null
	samsungTvDiscoveryDiagnostics: SamsungTvDiscoveryDiagnostics | null
	lutronDiscoveryDiagnostics: LutronDiscoveryDiagnostics | null
	sonosDiscoveryDiagnostics: SonosDiscoveryDiagnostics | null
}

const initialState: HomeConnectorState = {
	connection: {
		workerUrl: '',
		connectorId: '',
		connected: false,
		lastSyncAt: null,
		lastError: null,
		sharedSecret: null,
		mocksEnabled: false,
	},
	devices: [],
	rokuDiscoveryDiagnostics: null,
	samsungTvDiscoveryDiagnostics: null,
	lutronDiscoveryDiagnostics: null,
	sonosDiscoveryDiagnostics: null,
}

export function createAppState(): HomeConnectorState {
	return structuredClone(initialState)
}

export function updateConnectionState(
	state: HomeConnectorState,
	input: Partial<HomeConnectorConnectionState>,
) {
	state.connection = {
		...state.connection,
		...input,
	}
	return state.connection
}

export function setRokuDevices(
	state: HomeConnectorState,
	devices: Array<RokuDeviceRecord>,
) {
	state.devices = [...devices]
	return state.devices
}

export function setRokuDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: RokuDiscoveryDiagnostics | null,
) {
	state.rokuDiscoveryDiagnostics = diagnostics
	return state.rokuDiscoveryDiagnostics
}

export function setSamsungTvDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: SamsungTvDiscoveryDiagnostics | null,
) {
	state.samsungTvDiscoveryDiagnostics = diagnostics
	return state.samsungTvDiscoveryDiagnostics
}

export function setLutronDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: LutronDiscoveryDiagnostics | null,
) {
	state.lutronDiscoveryDiagnostics = diagnostics
	return state.lutronDiscoveryDiagnostics
}

export function setSonosDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: SonosDiscoveryDiagnostics | null,
) {
	state.sonosDiscoveryDiagnostics = diagnostics
	return state.sonosDiscoveryDiagnostics
}

export function getDiscoveredRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => !device.adopted)
}

export function getAdoptedRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => device.adopted)
}
