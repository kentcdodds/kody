import { type VenstarThermostatConfig } from '../../config.ts'
import {
	type VenstarControlRequest,
	type VenstarControlResponse,
	type VenstarInfoResponse,
	type VenstarRuntimesResponse,
	type VenstarSensorsResponse,
	type VenstarSettingsRequest,
	type VenstarSettingsResponse,
} from './types.ts'

function buildThermostatBaseUrl(thermostat: VenstarThermostatConfig) {
	const normalized = thermostat.ip.trim().replace(/^https?:\/\//i, '')
	return `http://${normalized.replace(/\/$/, '')}`
}

function buildThermostatUrl(
	thermostat: VenstarThermostatConfig,
	pathname: string,
) {
	const path = pathname.startsWith('/') ? pathname : `/${pathname}`
	return `${buildThermostatBaseUrl(thermostat)}${path}`
}

function createFormBody(payload: Record<string, string | number | boolean>) {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(payload)) {
		params.set(key, String(value))
	}
	return params.toString()
}

async function parseJsonResponse<T>(response: Response, label: string) {
	if (!response.ok) {
		throw new Error(`${label} failed with status ${response.status}.`)
	}
	return (await response.json()) as T
}

export async function fetchVenstarInfo(
	thermostat: VenstarThermostatConfig,
): Promise<VenstarInfoResponse> {
	const response = await fetch(
		buildThermostatUrl(thermostat, '/query/info'),
	)
	return await parseJsonResponse<VenstarInfoResponse>(
		response,
		'Venstar info request',
	)
}

export async function fetchVenstarSensors(
	thermostat: VenstarThermostatConfig,
): Promise<VenstarSensorsResponse> {
	const response = await fetch(
		buildThermostatUrl(thermostat, '/query/sensors'),
	)
	return await parseJsonResponse<VenstarSensorsResponse>(
		response,
		'Venstar sensors request',
	)
}

export async function fetchVenstarRuntimes(
	thermostat: VenstarThermostatConfig,
): Promise<VenstarRuntimesResponse> {
	const response = await fetch(
		buildThermostatUrl(thermostat, '/query/runtimes'),
	)
	return await parseJsonResponse<VenstarRuntimesResponse>(
		response,
		'Venstar runtimes request',
	)
}

export async function postVenstarControl(
	thermostat: VenstarThermostatConfig,
	payload: VenstarControlRequest,
): Promise<VenstarControlResponse> {
	const response = await fetch(
		buildThermostatUrl(thermostat, '/control'),
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: createFormBody(payload),
		},
	)
	return await parseJsonResponse<VenstarControlResponse>(
		response,
		'Venstar control request',
	)
}

export async function postVenstarSettings(
	thermostat: VenstarThermostatConfig,
	payload: VenstarSettingsRequest,
): Promise<VenstarSettingsResponse> {
	const mappedPayload: Record<string, string | number | boolean> = {}
	if (payload.away != null) mappedPayload['away'] = payload.away
	if (payload.schedule != null) mappedPayload['schedule'] = payload.schedule
	if (payload.tempunits != null) mappedPayload['tempunits'] = payload.tempunits
	if (payload.humidify != null) mappedPayload['hum'] = payload.humidify
	if (payload.dehumidify != null) mappedPayload['dehum'] = payload.dehumidify
	const response = await fetch(
		buildThermostatUrl(thermostat, '/settings'),
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: createFormBody(mappedPayload),
		},
	)
	return await parseJsonResponse<VenstarSettingsResponse>(
		response,
		'Venstar settings request',
	)
}
