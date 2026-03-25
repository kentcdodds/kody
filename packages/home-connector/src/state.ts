import {
	type RokuDeviceRecord,
	type RokuDiscoveryDiagnostics,
} from './adapters/roku/types.ts'

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

export function getDiscoveredRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => !device.adopted)
}

export function getAdoptedRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => device.adopted)
}
