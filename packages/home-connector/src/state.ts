import {
	type RokuDeviceRecord,
	type RokuDiscoveryDiagnostics,
} from './adapters/roku/types.ts'
import { type LutronDiscoveryDiagnostics } from './adapters/lutron/types.ts'
import { type SamsungTvDiscoveryDiagnostics } from './adapters/samsung-tv/types.ts'
import { type BondDiscoveryDiagnostics } from './adapters/bond/types.ts'
import {
	type JellyfishDiscoveredController,
	type JellyfishDiscoveryDiagnostics,
} from './adapters/jellyfish/types.ts'
import { type SonosDiscoveryDiagnostics } from './adapters/sonos/types.ts'
import {
	type VenstarDiscoveredThermostat,
	type VenstarDiscoveryDiagnostics,
} from './adapters/venstar/types.ts'

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
	bondDiscoveryDiagnostics: BondDiscoveryDiagnostics | null
	jellyfishDiscoveryDiagnostics: JellyfishDiscoveryDiagnostics | null
	jellyfishDiscoveredControllers: Array<JellyfishDiscoveredController>
	venstarDiscoveryDiagnostics: VenstarDiscoveryDiagnostics | null
	venstarDiscoveredThermostats: Array<VenstarDiscoveredThermostat>
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
	bondDiscoveryDiagnostics: null,
	jellyfishDiscoveryDiagnostics: null,
	jellyfishDiscoveredControllers: [],
	venstarDiscoveryDiagnostics: null,
	venstarDiscoveredThermostats: [],
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

export function setBondDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: BondDiscoveryDiagnostics | null,
) {
	state.bondDiscoveryDiagnostics = diagnostics
	return state.bondDiscoveryDiagnostics
}

export function setJellyfishDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: JellyfishDiscoveryDiagnostics | null,
) {
	state.jellyfishDiscoveryDiagnostics = diagnostics
	return state.jellyfishDiscoveryDiagnostics
}

export function setJellyfishDiscoveredControllers(
	state: HomeConnectorState,
	controllers: Array<JellyfishDiscoveredController>,
) {
	state.jellyfishDiscoveredControllers = [...controllers]
	return state.jellyfishDiscoveredControllers
}

export function setVenstarDiscoveryDiagnostics(
	state: HomeConnectorState,
	diagnostics: VenstarDiscoveryDiagnostics | null,
) {
	state.venstarDiscoveryDiagnostics = diagnostics
	return state.venstarDiscoveryDiagnostics
}

export function setVenstarDiscoveredThermostats(
	state: HomeConnectorState,
	thermostats: Array<VenstarDiscoveredThermostat>,
) {
	state.venstarDiscoveredThermostats = [...thermostats]
	return state.venstarDiscoveredThermostats
}

export function getDiscoveredRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => !device.adopted)
}

export function getAdoptedRokuDevices(state: HomeConnectorState) {
	return state.devices.filter((device) => device.adopted)
}
