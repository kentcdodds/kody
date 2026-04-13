import { createSocket } from 'node:dgram'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	setVenstarDiscoveredThermostats,
	setVenstarDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import {
	type VenstarDiscoveredThermostat,
	type VenstarDiscoveryDiagnostics,
	type VenstarInfoLookupDiagnostic,
	type VenstarSsdpHitDiagnostic,
} from './types.ts'

type VenstarSsdpDiscoveryConfig = {
	address: string
	port: number
	searchTarget: string
	mx: number
	timeoutMs: number
}

type VenstarSsdpLocation = {
	location: string
	usn: string | null
}

function parseNumberOrDefault(value: string | null, fallback: number) {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseSsdpDiscoveryUrl(
	discoveryUrl: string,
): VenstarSsdpDiscoveryConfig {
	const url = new URL(discoveryUrl)
	if (url.protocol !== 'ssdp:') {
		throw new Error(`Unsupported Venstar discovery protocol: ${url.protocol}`)
	}
	return {
		address: url.hostname || '239.255.255.250',
		port: parseNumberOrDefault(url.port || null, 1900),
		searchTarget:
			url.searchParams.get('st')?.trim() || 'venstar:thermostat:ecp',
		mx: parseNumberOrDefault(url.searchParams.get('mx'), 1),
		timeoutMs: parseNumberOrDefault(url.searchParams.get('timeoutMs'), 1_500),
	}
}

function createSsdpSearchMessage(input: VenstarSsdpDiscoveryConfig) {
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

function normalizeDeviceLocation(location: string) {
	const url = new URL(location)
	url.pathname = '/'
	url.search = ''
	url.hash = ''
	return url.toString()
}

async function fetchJson<T>(url: string, timeoutMs = 5_000): Promise<T> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(url, {
			signal: controller.signal,
		})
		if (!response.ok) {
			throw new Error(`Request failed (${response.status}) for ${url}`)
		}
		return (await response.json()) as T
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(`Request timed out for ${url}`)
		}
		throw error
	} finally {
		clearTimeout(timeout)
	}
}

function buildInfoUrl(location: string) {
	return `${location.replace(/\/$/, '')}/query/info`
}

async function discoverSsdpLocations(input: {
	discoveryUrl: string
	now: string
}): Promise<{
	locations: Array<VenstarSsdpLocation>
	hits: Array<VenstarSsdpHitDiagnostic>
}> {
	const config = parseSsdpDiscoveryUrl(input.discoveryUrl)
	const searchMessage = Buffer.from(createSsdpSearchMessage(config))
	const socket = createSocket('udp4')
	const locations = new Map<string, VenstarSsdpLocation>()
	const hits: Array<VenstarSsdpHitDiagnostic> = []

	socket.on('message', (message, remote) => {
		const raw = message.toString()
		const headers = parseHttpLikeHeaders(raw)
		const locationHeader = headers.get('location')
		let location: string | null = null
		if (locationHeader) {
			try {
				location = normalizeDeviceLocation(locationHeader)
			} catch {
				location = null
			}
		}
		hits.push({
			receivedAt: input.now,
			remoteAddress: remote.address,
			remotePort: remote.port,
			raw,
			location,
			usn: headers.get('usn') ?? null,
			server: headers.get('server') ?? null,
		})
		if (!location) return
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

async function buildThermostatFromLocation(input: {
	location: VenstarSsdpLocation
	index: number
}): Promise<{
	thermostat: VenstarDiscoveredThermostat
	diagnostic: VenstarInfoLookupDiagnostic
}> {
	const location = normalizeDeviceLocation(input.location.location)
	const infoUrl = buildInfoUrl(location)
	const ip = new URL(location).host
	try {
		const info = await fetchJson<Record<string, unknown>>(infoUrl)
		const discoveredName =
			typeof info['name'] === 'string' && info['name'].trim()
				? info['name'].trim()
				: typeof info['thermostat_name'] === 'string' &&
					  info['thermostat_name'].trim()
					? info['thermostat_name'].trim()
					: typeof info['name1'] === 'string' && info['name1'].trim()
						? info['name1'].trim()
						: `Venstar thermostat ${String(input.index + 1)}`
		return {
			thermostat: {
				name: discoveredName,
				ip,
				location,
				usn: input.location.usn,
				lastSeenAt: new Date().toISOString(),
				rawDiscovery: info,
			},
			diagnostic: {
				location,
				infoUrl,
				raw: info,
				parsed: {
					name: discoveredName,
					ip,
					mode: typeof info['mode'] === 'number' ? info['mode'] : null,
					spacetemp:
						typeof info['spacetemp'] === 'number' ? info['spacetemp'] : null,
					humidity:
						typeof info['humidity'] === 'number' ? info['humidity'] : null,
				},
				error: null,
			},
		}
	} catch (error) {
		const fallbackName =
			input.location.usn
				?.match(/name:([^:]+)/i)?.[1]
				?.replaceAll('%20', ' ')
				?.trim() || `Venstar thermostat ${String(input.index + 1)}`
		return {
			thermostat: {
				name: fallbackName,
				ip,
				location,
				usn: input.location.usn,
				lastSeenAt: new Date().toISOString(),
				rawDiscovery: null,
			},
			diagnostic: {
				location,
				infoUrl,
				raw: null,
				parsed: null,
				error: error instanceof Error ? error.message : String(error),
			},
		}
	}
}

async function discoverVenstarThermostatsFromSsdp(
	discoveryUrl: string,
): Promise<{
	thermostats: Array<VenstarDiscoveredThermostat>
	diagnostics: VenstarDiscoveryDiagnostics
}> {
	const now = new Date().toISOString()
	const { locations, hits } = await discoverSsdpLocations({
		discoveryUrl,
		now,
	})
	const lookups = await Promise.all(
		locations.map((location, index) =>
			buildThermostatFromLocation({
				location,
				index,
			}),
		),
	)
	return {
		thermostats: lookups.map((lookup) => lookup.thermostat),
		diagnostics: {
			protocol: 'ssdp',
			discoveryUrl,
			scannedAt: now,
			jsonResponse: null,
			ssdpHits: hits,
			infoLookups: lookups.map((lookup) => lookup.diagnostic),
		},
	}
}

async function discoverVenstarThermostatsFromJson(
	discoveryUrl: string,
): Promise<{
	thermostats: Array<VenstarDiscoveredThermostat>
	diagnostics: VenstarDiscoveryDiagnostics
}> {
	const now = new Date().toISOString()
	const payload = await fetchJson<{
		thermostats?: Array<Record<string, unknown>>
	}>(discoveryUrl)
	const thermostats = (payload.thermostats ?? [])
		.map((entry) => {
			const name = String(entry['name'] ?? '').trim()
			const ip = String(entry['ip'] ?? '').trim()
			const location =
				typeof entry['location'] === 'string' && entry['location'].trim()
					? entry['location'].trim()
					: ip
						? `http://${ip.replace(/^https?:\/\//i, '').replace(/\/$/, '')}/`
						: ''
			if (!name || !ip || !location) return null
			return {
				name,
				ip,
				location,
				usn: typeof entry['usn'] === 'string' ? entry['usn'] : null,
				lastSeenAt:
					typeof entry['lastSeenAt'] === 'string' ? entry['lastSeenAt'] : now,
				rawDiscovery: entry,
			}
		})
		.filter((entry): entry is VenstarDiscoveredThermostat => entry != null)
	return {
		thermostats,
		diagnostics: {
			protocol: 'json',
			discoveryUrl,
			scannedAt: now,
			jsonResponse: payload as Record<string, unknown>,
			ssdpHits: [],
			infoLookups: thermostats.map((thermostat) => ({
				location: thermostat.location,
				infoUrl: buildInfoUrl(thermostat.location),
				raw:
					thermostat.rawDiscovery && typeof thermostat.rawDiscovery === 'object'
						? thermostat.rawDiscovery
						: null,
				parsed: {
					name: thermostat.name,
					ip: thermostat.ip,
					mode: null,
					spacetemp: null,
					humidity: null,
				},
				error: null,
			})),
		},
	}
}

export async function scanVenstarThermostats(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = config.venstarDiscoveryUrl.startsWith('http')
		? await discoverVenstarThermostatsFromJson(config.venstarDiscoveryUrl)
		: await discoverVenstarThermostatsFromSsdp(config.venstarDiscoveryUrl)
	setVenstarDiscoveredThermostats(state, result.thermostats)
	setVenstarDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
