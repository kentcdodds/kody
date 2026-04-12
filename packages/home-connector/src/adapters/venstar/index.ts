import { type HomeConnectorConfig } from '../../config.ts'
import {
	fetchVenstarInfo,
	fetchVenstarRuntimes,
	fetchVenstarSensors,
	postVenstarControl,
	postVenstarSettings,
} from './client.ts'
import {
	type VenstarControlRequest,
	type VenstarInfoResponse,
	type VenstarRuntimesResponse,
	type VenstarSensorsResponse,
	type VenstarSettingsRequest,
} from './types.ts'

const autoModeValue = 3

function normalizeThermostatName(value: string) {
	return value.trim().toLowerCase()
}

function normalizeThermostatIp(value: string) {
	return value.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

function resolveThermostat(config: HomeConnectorConfig, identifier?: string) {
	const thermostats = config.venstarThermostats
	if (thermostats.length === 0) {
		throw new Error(
			'No Venstar thermostats are configured. Update the venstar-thermostats.json file or VENSTAR_THERMOSTATS env var.',
		)
	}
	if (!identifier) {
		if (thermostats.length === 1) return thermostats[0]!
		throw new Error(
			'Multiple Venstar thermostats are configured. Provide a thermostat name or IP.',
		)
	}
	const normalized = normalizeThermostatName(identifier)
	const normalizedIp = normalizeThermostatIp(identifier)
	const match =
		thermostats.find(
			(entry) => normalizeThermostatName(entry.name) === normalized,
		) ??
		thermostats.find((entry) => entry.ip.trim() === identifier.trim()) ??
		thermostats.find(
			(entry) => normalizeThermostatIp(entry.ip) === normalizedIp,
		)
	if (!match) {
		throw new Error(`Venstar thermostat "${identifier}" was not found.`)
	}
	return match
}

function ensureAutoModeSetpoints(
	request: VenstarControlRequest,
	info: VenstarInfoResponse,
) {
	const mode = request.mode ?? info.mode
	if (mode !== autoModeValue) return
	const heat = request.heattemp ?? info.heattemp
	const cool = request.cooltemp ?? info.cooltemp
	const delta = info.setpointdelta ?? 0
	if (cool <= heat + delta) {
		throw new Error(
			`Auto mode requires cooltemp (${cool}) to be greater than heattemp (${heat}) + setpointdelta (${delta}).`,
		)
	}
}

function buildInfoSummary(info: VenstarInfoResponse) {
	return {
		mode: info.mode,
		state: info.state,
		fan: info.fan,
		spacetemp: info.spacetemp,
		heattemp: info.heattemp,
		cooltemp: info.cooltemp,
		humidity: info.humidity,
		schedule: info.schedule,
		away: info.away,
		setpointdelta: info.setpointdelta,
		units: info.tempunits,
	}
}

function buildOfflineSummary(message: string) {
	return {
		mode: null,
		state: null,
		fan: null,
		spacetemp: null,
		heattemp: null,
		cooltemp: null,
		humidity: null,
		schedule: null,
		away: null,
		setpointdelta: null,
		units: null,
		status: 'offline',
		message,
	}
}

type VenstarInfoSummary = ReturnType<typeof buildInfoSummary>
type VenstarStatusSummary =
	| VenstarInfoSummary
	| (ReturnType<typeof buildOfflineSummary> & { status: 'offline' })

export function createVenstarAdapter(input: { config: HomeConnectorConfig }) {
	const { config } = input

	return {
		listThermostats() {
			return config.venstarThermostats
		},
		async listThermostatsWithStatus(): Promise<
			Array<
				(typeof config.venstarThermostats)[number] & {
					info: VenstarInfoResponse | null
					summary: VenstarStatusSummary
				}
			>
		> {
			return await Promise.all(
				config.venstarThermostats.map(async (thermostat) => {
					try {
						const info = await fetchVenstarInfo(thermostat)
						return {
							...thermostat,
							info,
							summary: buildInfoSummary(info),
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error)
						return {
							...thermostat,
							info: null,
							summary: buildOfflineSummary(message),
						}
					}
				}),
			)
		},
		async getInfo(identifier?: string) {
			const thermostat = resolveThermostat(config, identifier)
			const info = await fetchVenstarInfo(thermostat)
			return {
				thermostat,
				info,
				summary: buildInfoSummary(info),
			}
		},
		async getSensors(identifier?: string): Promise<{
			thermostat: (typeof config.venstarThermostats)[number]
			sensors: VenstarSensorsResponse
		}> {
			const thermostat = resolveThermostat(config, identifier)
			const sensors = await fetchVenstarSensors(thermostat)
			return { thermostat, sensors }
		},
		async getRuntimes(identifier?: string): Promise<{
			thermostat: (typeof config.venstarThermostats)[number]
			runtimes: VenstarRuntimesResponse
		}> {
			const thermostat = resolveThermostat(config, identifier)
			const runtimes = await fetchVenstarRuntimes(thermostat)
			return { thermostat, runtimes }
		},
		async controlThermostat(
			request: VenstarControlRequest & { thermostat?: string },
		) {
			const { thermostat: identifier, ...payload } = request
			const thermostat = resolveThermostat(config, identifier)
			const info = await fetchVenstarInfo(thermostat)
			ensureAutoModeSetpoints(payload, info)
			const response = await postVenstarControl(thermostat, payload)
			const updatedInfo = await fetchVenstarInfo(thermostat)
			return {
				thermostat,
				request: payload,
				response,
				info: buildInfoSummary(updatedInfo),
			}
		},
		async setSettings(
			request: VenstarSettingsRequest & { thermostat?: string },
		) {
			const { thermostat: identifier, ...payload } = request
			const thermostat = resolveThermostat(config, identifier)
			const response = await postVenstarSettings(thermostat, payload)
			return {
				thermostat,
				request: payload,
				response,
			}
		},
	}
}
