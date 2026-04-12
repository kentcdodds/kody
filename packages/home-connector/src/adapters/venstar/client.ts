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

const venstarRequestTimeoutMs = 5_000

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

async function fetchWithTimeout(input: {
	url: string
	init?: RequestInit
	label: string
}) {
	let response: Response
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), venstarRequestTimeoutMs)
	try {
		response = await fetch(input.url, {
			...input.init,
			signal: controller.signal,
		})
	} catch (error) {
		if (
			error instanceof Error &&
			(error.name === 'TimeoutError' || error.name === 'AbortError')
		) {
			throw new Error(
				`${input.label} timed out after ${venstarRequestTimeoutMs}ms.`,
			)
		}
		throw error
	} finally {
		clearTimeout(timeout)
	}
	return response
}

export async function fetchVenstarInfo(
	thermostat: VenstarThermostatConfig,
): Promise<VenstarInfoResponse> {
	const response = await fetchWithTimeout({
		url: buildThermostatUrl(thermostat, '/query/info'),
		label: 'Venstar info request',
	})
	return await parseJsonResponse<VenstarInfoResponse>(
		response,
		'Venstar info request',
	)
}

export async function fetchVenstarSensors(
	thermostat: VenstarThermostatConfig,
): Promise<VenstarSensorsResponse> {
	const response = await fetchWithTimeout({
		url: buildThermostatUrl(thermostat, '/query/sensors'),
		label: 'Venstar sensors request',
	})
	return await parseJsonResponse<VenstarSensorsResponse>(
		response,
		'Venstar sensors request',
	)
}

export async function fetchVenstarRuntimes(
	thermostat: VenstarThermostatConfig,
): Promise<VenstarRuntimesResponse> {
	const response = await fetchWithTimeout({
		url: buildThermostatUrl(thermostat, '/query/runtimes'),
		label: 'Venstar runtimes request',
	})
	return await parseJsonResponse<VenstarRuntimesResponse>(
		response,
		'Venstar runtimes request',
	)
}

export async function postVenstarControl(
	thermostat: VenstarThermostatConfig,
	payload: VenstarControlRequest,
): Promise<VenstarControlResponse> {
	const mappedPayload: Record<string, string | number | boolean> = {}
	if (payload.mode != null) mappedPayload['mode'] = payload.mode
	if (payload.fan != null) mappedPayload['fan'] = payload.fan
	if (payload.heattemp != null) mappedPayload['heattemp'] = payload.heattemp
	if (payload.cooltemp != null) mappedPayload['cooltemp'] = payload.cooltemp
	const response = await fetchWithTimeout({
		url: buildThermostatUrl(thermostat, '/control'),
		label: 'Venstar control request',
		init: {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: createFormBody(mappedPayload),
		},
	})
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
	const response = await fetchWithTimeout({
		url: buildThermostatUrl(thermostat, '/settings'),
		label: 'Venstar settings request',
		init: {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: createFormBody(mappedPayload),
		},
	})
	return await parseJsonResponse<VenstarSettingsResponse>(
		response,
		'Venstar settings request',
	)
}
