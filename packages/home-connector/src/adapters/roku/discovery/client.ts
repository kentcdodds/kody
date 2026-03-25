import { createSocket } from 'node:dgram'
import {
	type RokuDeviceInfoDiagnostic,
	type RokuDiscoveredDevice,
	type RokuDiscoveryResult,
	type RokuSsdpHitDiagnostic,
} from '../types.ts'
import { captureHomeConnectorException } from '../../../sentry.ts'

type RokuDeviceInfoResponse = {
	id?: string
	udn?: string
	name?: string
	location?: string
	serialNumber?: string
	modelName?: string
	friendlyName?: string
	endpoint?: string
	adopted?: boolean
	isAdopted?: boolean
	lastSeenAt?: string
	controlEnabled?: boolean
}

type RokuSsdpDiscoveryConfig = {
	address: string
	port: number
	searchTarget: string
	mx: number
	timeoutMs: number
}

type RokuSsdpLocation = {
	location: string
	usn: string | null
}

type RokuDeviceInfoXml = {
	name: string | null
	serialNumber: string | null
	modelName: string | null
}

function normalizeBaseUrl(url: string) {
	return url.endsWith('/') ? url.slice(0, -1) : url
}

function normalizeDeviceLocation(location: string) {
	const url = new URL(location)
	url.pathname = '/'
	url.search = ''
	url.hash = ''
	return url.toString()
}

function parseNumberOrDefault(value: string | null, fallback: number) {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseSsdpDiscoveryUrl(discoveryUrl: string): RokuSsdpDiscoveryConfig {
	const url = new URL(discoveryUrl)
	if (url.protocol !== 'ssdp:') {
		throw new Error(`Unsupported Roku discovery protocol: ${url.protocol}`)
	}

	return {
		address: url.hostname || '239.255.255.250',
		port: parseNumberOrDefault(url.port || null, 1900),
		searchTarget: url.searchParams.get('st')?.trim() || 'roku:ecp',
		mx: parseNumberOrDefault(url.searchParams.get('mx'), 1),
		timeoutMs: parseNumberOrDefault(url.searchParams.get('timeoutMs'), 1500),
	}
}

function createSsdpSearchMessage(input: RokuSsdpDiscoveryConfig) {
	return [
		'M-SEARCH * HTTP/1.1',
		`HOST: ${input.address}:${input.port}`,
		'MAN: "ssdp:discover"',
		`MX: ${input.mx}`,
		`ST: ${input.searchTarget}`,
		'',
		'',
	].join('\r\n')
}

function parseHttpLikeHeaders(message: string) {
	const headers = new Map<string, string>()
	for (const line of message.split(/\r?\n/)) {
		const separatorIndex = line.indexOf(':')
		if (separatorIndex === -1) continue
		const key = line.slice(0, separatorIndex).trim().toLowerCase()
		const value = line.slice(separatorIndex + 1).trim()
		if (!key || !value) continue
		headers.set(key, value)
	}
	return headers
}

function readXmlTag(xml: string, tagName: string) {
	const match = xml.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i'))
	return match?.[1]?.trim() || null
}

function parseRokuDeviceInfoXml(xml: string): RokuDeviceInfoXml {
	return {
		name:
			readXmlTag(xml, 'user-device-name') ||
			readXmlTag(xml, 'friendly-device-name') ||
			readXmlTag(xml, 'friendlyName') ||
			null,
		serialNumber:
			readXmlTag(xml, 'serial-number') ||
			readXmlTag(xml, 'serialNumber') ||
			null,
		modelName:
			readXmlTag(xml, 'model-name') ||
			readXmlTag(xml, 'friendly-model-name') ||
			readXmlTag(xml, 'modelName') ||
			null,
	}
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(`Request failed (${response.status}) for ${url}`)
	}
	return (await response.json()) as T
}

async function fetchText(url: string) {
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(`Request failed (${response.status}) for ${url}`)
	}
	return response.text()
}

function normalizeJsonDiscoveryDevice(
	device: RokuDeviceInfoResponse,
	index: number,
	discoveryUrl: string,
	now: string,
): RokuDiscoveredDevice {
	return {
		id:
			device.id?.trim() ||
			device.udn?.trim() ||
			device.serialNumber?.trim() ||
			`roku-${index.toString(10)}`,
		name:
			device.name?.trim() ||
			device.friendlyName?.trim() ||
			device.serialNumber?.trim() ||
			'Unknown Roku device',
		location:
			device.location?.trim() ||
			device.endpoint?.trim() ||
			`${normalizeBaseUrl(discoveryUrl)}/ecp/${index}`,
		serialNumber: device.serialNumber?.trim() || null,
		modelName: device.modelName?.trim() || null,
		isAdopted: device.isAdopted ?? device.adopted ?? false,
		lastSeenAt: device.lastSeenAt ?? now,
		controlEnabled: device.controlEnabled ?? true,
	}
}

async function discoverRokuDevicesFromJson(input: {
	discoveryUrl: string
	now: string
}): Promise<RokuDiscoveryResult> {
	const response = await fetchJson<{
		devices?: Array<RokuDeviceInfoResponse>
	}>(input.discoveryUrl)
	return {
		devices: (response.devices ?? []).map((device, index) =>
			normalizeJsonDiscoveryDevice(
				device,
				index,
				input.discoveryUrl,
				input.now,
			),
		),
		diagnostics: {
			protocol: 'json',
			discoveryUrl: input.discoveryUrl,
			scannedAt: input.now,
			jsonResponse: response as Record<string, unknown>,
			ssdpHits: [],
			deviceInfoLookups: [],
		},
	}
}

async function discoverSsdpLocations(input: {
	discoveryUrl: string
	now: string
}): Promise<{
	locations: Array<RokuSsdpLocation>
	hits: Array<RokuSsdpHitDiagnostic>
}> {
	const config = parseSsdpDiscoveryUrl(input.discoveryUrl)
	const searchMessage = Buffer.from(createSsdpSearchMessage(config))
	const socket = createSocket('udp4')
	const locations = new Map<string, RokuSsdpLocation>()
	const hits: Array<RokuSsdpHitDiagnostic> = []

	socket.on('message', (message, remote) => {
		const raw = message.toString()
		const headers = parseHttpLikeHeaders(raw)
		const locationHeader = headers.get('location')
		hits.push({
			receivedAt: input.now,
			remoteAddress: remote.address,
			remotePort: remote.port,
			raw,
			location: locationHeader ? normalizeDeviceLocation(locationHeader) : null,
			usn: headers.get('usn') ?? null,
			server: headers.get('server') ?? null,
		})
		if (!locationHeader) return
		const location = normalizeDeviceLocation(locationHeader)
		if (locations.has(location)) return
		locations.set(location, {
			location,
			usn: headers.get('usn') ?? null,
		})
	})

	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false

			function cleanup() {
				socket.off('error', handleError)
			}

			function handleError(error: Error) {
				if (settled) return
				settled = true
				cleanup()
				reject(error)
			}

			socket.on('error', handleError)
			socket.bind(0, () => {
				socket.send(searchMessage, config.port, config.address, (error) => {
					if (error) {
						handleError(error)
						return
					}

					setTimeout(() => {
						if (settled) return
						settled = true
						cleanup()
						resolve()
					}, config.timeoutMs)
				})
			})
		})
	} finally {
		socket.close()
	}

	return {
		locations: [...locations.values()],
		hits,
	}
}

async function buildRokuDeviceFromSsdpLocation(input: {
	location: RokuSsdpLocation
	index: number
	now: string
}): Promise<{
	device: RokuDiscoveredDevice
	diagnostic: RokuDeviceInfoDiagnostic
}> {
	const location = normalizeDeviceLocation(input.location.location)
	const deviceInfoUrl = `${normalizeBaseUrl(location)}/query/device-info`

	try {
		const xml = await fetchText(deviceInfoUrl)
		const deviceInfo = parseRokuDeviceInfoXml(xml)
		return {
			device: {
				id:
					deviceInfo.serialNumber ||
					input.location.usn?.trim() ||
					`roku-${input.index.toString(10)}`,
				name:
					deviceInfo.name ||
					deviceInfo.serialNumber ||
					input.location.usn?.trim() ||
					'Unknown Roku device',
				location,
				serialNumber: deviceInfo.serialNumber,
				modelName: deviceInfo.modelName,
				isAdopted: false,
				lastSeenAt: input.now,
				controlEnabled: true,
			},
			diagnostic: {
				location,
				deviceInfoUrl,
				raw: xml,
				parsed: deviceInfo,
				error: null,
			},
		}
	} catch (error) {
		captureHomeConnectorException(error, {
			tags: {
				operation: 'roku.device_info_lookup',
			},
			contexts: {
				roku: {
					location,
					deviceInfoUrl,
				},
			},
		})
		return {
			device: {
				id: input.location.usn?.trim() || `roku-${input.index.toString(10)}`,
				name: input.location.usn?.trim() || 'Unknown Roku device',
				location,
				serialNumber: null,
				modelName: null,
				isAdopted: false,
				lastSeenAt: input.now,
				controlEnabled: true,
			},
			diagnostic: {
				location,
				deviceInfoUrl,
				raw: null,
				parsed: null,
				error: error instanceof Error ? error.message : String(error),
			},
		}
	}
}

async function discoverRokuDevicesFromSsdp(input: {
	discoveryUrl: string
	now: string
}): Promise<RokuDiscoveryResult> {
	const { locations, hits } = await discoverSsdpLocations({
		discoveryUrl: input.discoveryUrl,
		now: input.now,
	})
	const devices = await Promise.all(
		locations.map((location, index) =>
			buildRokuDeviceFromSsdpLocation({
				location,
				index,
				now: input.now,
			}),
		),
	)
	return {
		devices: devices.map((entry) => entry.device),
		diagnostics: {
			protocol: 'ssdp',
			discoveryUrl: input.discoveryUrl,
			scannedAt: input.now,
			jsonResponse: null,
			ssdpHits: hits,
			deviceInfoLookups: devices.map((entry) => entry.diagnostic),
		},
	}
}

export async function discoverRokuDevicesWithDiagnostics(input: {
	discoveryUrl: string
}): Promise<RokuDiscoveryResult> {
	const protocol = new URL(input.discoveryUrl).protocol
	const now = new Date().toISOString()

	switch (protocol) {
		case 'http:':
		case 'https:':
			return discoverRokuDevicesFromJson({
				discoveryUrl: input.discoveryUrl,
				now,
			})
		case 'ssdp:':
			return discoverRokuDevicesFromSsdp({
				discoveryUrl: input.discoveryUrl,
				now,
			})
		default:
			throw new Error(`Unsupported Roku discovery protocol: ${protocol}`)
	}
}

export async function discoverRokuDevices(input: {
	discoveryUrl: string
}): Promise<Array<RokuDiscoveredDevice>> {
	const result = await discoverRokuDevicesWithDiagnostics(input)
	return result.devices
}
