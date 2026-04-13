import {
	type VenstarControlRequest,
	type VenstarControlResponse,
	type VenstarInfoResponse,
	type VenstarRuntimesResponse,
	type VenstarSensorsResponse,
	type VenstarSettingsRequest,
	type VenstarSettingsResponse,
} from './types.ts'

type MockThermostatState = {
	info: VenstarInfoResponse
	sensors: VenstarSensorsResponse
	runtimes: VenstarRuntimesResponse
}

export type MockVenstarDiscoveryEntry = {
	name: string
	ip: string
	location: string
	usn: string
}

const defaultInfo: VenstarInfoResponse = {
	mode: 3,
	state: 0,
	fan: 0,
	spacetemp: 72,
	heattemp: 68,
	cooltemp: 74,
	humidity: 41,
	schedule: 1,
	away: 0,
	setpointdelta: 2,
	tempunits: 0,
}

const defaultSensors: VenstarSensorsResponse = {
	sensors: [
		{
			name: 'Thermostat',
			temp: 72,
			hum: 41,
			enabled: 1,
		},
		{
			name: 'Living Room',
			temp: 71,
			hum: 40,
			enabled: 1,
		},
	],
}

const defaultRuntimes: VenstarRuntimesResponse = {
	runtimes: [
		{
			ts: '2026-04-01T12:00:00Z',
			heat: 120,
			cool: 0,
			fan: 180,
		},
		{
			ts: '2026-04-01T13:00:00Z',
			heat: 60,
			cool: 30,
			fan: 90,
		},
	],
}

const mockThermostats: Record<string, MockThermostatState> = {}

function createDefaultThermostatState(): MockThermostatState {
	return {
		info: { ...defaultInfo },
		sensors: structuredClone(defaultSensors),
		runtimes: structuredClone(defaultRuntimes),
	}
}

export function resetMockVenstarState() {
	mockThermostats['192.168.10.40'] = {
		info: { ...defaultInfo, name: 'Hallway', spacetemp: 71 },
		sensors: structuredClone(defaultSensors),
		runtimes: structuredClone(defaultRuntimes),
	}
	mockThermostats['192.168.10.41'] = {
		info: { ...defaultInfo, name: 'Office', spacetemp: 74, humidity: 38 },
		sensors: structuredClone(defaultSensors),
		runtimes: structuredClone(defaultRuntimes),
	}
}

resetMockVenstarState()

function getThermostatState(ip: string) {
	const normalized = ip
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/$/, '')
	const existing = mockThermostats[normalized]
	if (existing) return existing
	const created = createDefaultThermostatState()
	mockThermostats[normalized] = created
	return created
}

export function getMockVenstarInfo(ip: string): VenstarInfoResponse {
	return getThermostatState(ip).info
}

export function getMockVenstarSensors(ip: string): VenstarSensorsResponse {
	return getThermostatState(ip).sensors
}

export function getMockVenstarRuntimes(ip: string): VenstarRuntimesResponse {
	return getThermostatState(ip).runtimes
}

export function applyMockVenstarControl(
	ip: string,
	request: VenstarControlRequest,
): VenstarControlResponse {
	const state = getThermostatState(ip)
	state.info = {
		...state.info,
		...request,
	}
	return {
		success: true,
	}
}

export function applyMockVenstarSettings(
	ip: string,
	request: VenstarSettingsRequest,
): VenstarSettingsResponse {
	const state = getThermostatState(ip)
	state.info = {
		...state.info,
		...(request.away == null ? {} : { away: request.away }),
		...(request.schedule == null ? {} : { schedule: request.schedule }),
		...(request.tempunits == null ? {} : { tempunits: request.tempunits }),
	}
	state.sensors = {
		...state.sensors,
		sensors: state.sensors.sensors.map((sensor, index) =>
			index === 0
				? {
						...sensor,
						hum:
							typeof request.humidify === 'number'
								? request.humidify
								: sensor.hum,
					}
				: sensor,
		),
	}
	return {
		success: true,
	}
}

export function listMockVenstarDiscoveryEntries(): Array<MockVenstarDiscoveryEntry> {
	return Object.entries(mockThermostats).map(([ip, state], index) => ({
		name:
			typeof state.info.name === 'string' && state.info.name.trim().length > 0
				? state.info.name.trim()
				: `Mock Venstar ${String(index + 1)}`,
		ip,
		location: `http://${ip}/`,
		usn: `colortouch:ecp:00:23:a7:3a:b2:${String(index + 10).padStart(2, '0')}:name:${encodeURIComponent(
			typeof state.info.name === 'string' && state.info.name.trim().length > 0
				? state.info.name.trim()
				: `Mock Venstar ${String(index + 1)}`,
		)}:type:residential`,
	}))
}

export function getMockVenstarDiscoveryPayload() {
	return {
		thermostats: listMockVenstarDiscoveryEntries(),
	}
}
