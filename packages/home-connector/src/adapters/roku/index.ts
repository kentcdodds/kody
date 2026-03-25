import {
	adoptRokuDevice,
	getAdoptedRokuDevices,
	getDiscoveredRokuDevices,
	ignoreRokuDevice,
	updateDiscoveredRokuDevices,
} from './devices/repository.ts'
import { discoverRokuDevicesWithDiagnostics } from './discovery/client.ts'
import {
	setRokuDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	type RokuActiveAppResult,
	type RokuAppInfo,
	type RokuAppListResult,
	type RokuDeviceRecord,
	type RokuDiscoveredDevice,
} from './types.ts'

function createDeviceId(input: RokuDiscoveredDevice) {
	const base = input.serialNumber || input.location || input.id || input.name
	return `roku-${base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

export async function scanRokuDevices(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = await discoverRokuDevicesWithDiagnostics({
		discoveryUrl: config.rokuDiscoveryUrl,
	})
	const now = new Date().toISOString()
	const normalized = result.devices.map((device) => ({
		...device,
		deviceId: createDeviceId(device),
		lastSeenAt: now,
		adopted: device.isAdopted,
	}))
	updateDiscoveredRokuDevices(state, normalized)
	setRokuDiscoveryDiagnostics(state, result.diagnostics)
	return normalized
}

export function getRokuStatus(state: HomeConnectorState) {
	return {
		discovered: getDiscoveredRokuDevices(state),
		adopted: getAdoptedRokuDevices(state),
		diagnostics: state.rokuDiscoveryDiagnostics,
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

function buildDeviceControlUrl(device: RokuDeviceRecord, key: string) {
	return `${device.location.replace(/\/$/, '')}/keypress/${encodeURIComponent(key)}`
}

function buildDeviceLaunchUrl(
	device: RokuDeviceRecord,
	appId: string,
	params: Record<string, string>,
) {
	const launchUrl = new URL(
		`${device.location.replace(/\/$/, '')}/launch/${encodeURIComponent(appId)}`,
	)
	for (const [key, value] of Object.entries(params)) {
		launchUrl.searchParams.set(key, value)
	}
	return launchUrl.toString()
}

function parseRokuAppInfoXml(appXml: string): RokuAppInfo {
	const idMatch = appXml.match(/\bid="([^"]*)"/i)
	const typeMatch = appXml.match(/\btype="([^"]*)"/i)
	const versionMatch = appXml.match(/\bversion="([^"]*)"/i)
	const nameMatch = appXml.match(/>([^<]*)<\/app>/i)
	return {
		id: idMatch?.[1]?.trim() || '',
		name: nameMatch?.[1]?.trim() || '',
		type: typeMatch?.[1]?.trim() || '',
		version: versionMatch?.[1]?.trim() || '',
	}
}

function parseRokuAppListXml(xml: string): Array<RokuAppInfo> {
	const appMatches =
		xml.match(/<app\b[^>]*?(?:\/>|>[\s\S]*?<\/app>)/gi) ?? []
	return appMatches
		.map((appXml) => parseRokuAppInfoXml(appXml))
		.filter((app) => app.id && app.name)
}

function parseRokuActiveAppXml(xml: string): RokuAppInfo | null {
	const match = xml.match(/<app\b[^>]*?(?:\/>|>[\s\S]*?<\/app>)/i)
	if (!match) return null
	const app = parseRokuAppInfoXml(match[0])
	if (!app.id || !app.name) return null
	return app
}

async function sendRokuKeypress(input: {
	device: RokuDeviceRecord
	key: string
}) {
	const targetUrl = buildDeviceControlUrl(input.device, input.key)
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

async function launchRokuApp(input: {
	device: RokuDeviceRecord
	appId: string
	params?: Record<string, string>
}) {
	const params = input.params ?? {}
	const targetUrl = buildDeviceLaunchUrl(input.device, input.appId, params)
	const response = await fetch(targetUrl, {
		method: 'POST',
	})
	if (!response.ok) {
		throw new Error(`Roku app launch failed with status ${response.status}.`)
	}
	const responseText = await response.text()
	return {
		ok: true,
		deviceId: input.device.deviceId,
		appId: input.appId,
		params,
		responseText,
	}
}

async function fetchRokuAppList(input: {
	device: RokuDeviceRecord
}): Promise<RokuAppListResult> {
	const targetUrl = `${input.device.location.replace(/\/$/, '')}/query/apps`
	const response = await fetch(targetUrl, {
		method: 'GET',
	})
	if (!response.ok) {
		throw new Error(`Roku app list failed with status ${response.status}.`)
	}
	const responseText = await response.text()
	const apps = parseRokuAppListXml(responseText)
	return {
		deviceId: input.device.deviceId,
		deviceName: input.device.name,
		apps,
		responseText,
	}
}

async function fetchRokuActiveApp(input: {
	device: RokuDeviceRecord
}): Promise<RokuActiveAppResult> {
	const targetUrl = `${input.device.location.replace(/\/$/, '')}/query/active-app`
	const response = await fetch(targetUrl, {
		method: 'GET',
	})
	if (!response.ok) {
		throw new Error(`Roku active app query failed with status ${response.status}.`)
	}
	const responseText = await response.text()
	const app = parseRokuActiveAppXml(responseText)
	return {
		deviceId: input.device.deviceId,
		deviceName: input.device.name,
		app,
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
			const status = getRokuStatus(input.state)
			return {
				discovered: status.discovered,
				adopted: status.adopted,
				diagnostics: status.diagnostics,
				allDevices: [...status.adopted, ...status.discovered],
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
				device,
				key,
			})
		},
		async launchApp(
			deviceId: string,
			appId: string,
			params?: Record<string, string>,
		) {
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return launchRokuApp({
				device,
				appId,
				params,
			})
		},
		async listApps(deviceId: string) {
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return fetchRokuAppList({ device })
		},
		async getActiveApp(deviceId: string) {
			const device = getDeviceOrThrow(input.state, deviceId)
			if (!device.adopted) {
				throw new Error(
					`Roku device "${deviceId}" must be adopted before control.`,
				)
			}
			return fetchRokuActiveApp({ device })
		},
	}
}
