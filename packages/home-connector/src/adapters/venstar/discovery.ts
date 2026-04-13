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
	type VenstarSubnetProbeSummary,
} from './types.ts'

type VenstarLocation = {
	location: string
	usn: string | null
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

function looksLikeVenstarInfo(body: unknown): body is Record<string, unknown> {
	if (!body || typeof body !== 'object') return false
	const record = body as Record<string, unknown>
	return (
		typeof record['mode'] === 'number' &&
		typeof record['state'] === 'number' &&
		typeof record['spacetemp'] === 'number'
	)
}

function expandVenstarScanCidr(cidr: string): Array<string> {
	const trimmed = cidr.trim()
	const single = /^(\d{1,3}(?:\.\d{1,3}){3})\/32$/i.exec(trimmed)
	if (single) {
		const ip = single[1] ?? ''
		const parts = ip.split('.').map((octet) => Number.parseInt(octet, 10))
		if (
			parts.length === 4 &&
			parts.every(
				(octet) => Number.isFinite(octet) && octet >= 0 && octet <= 255,
			)
		) {
			return [ip]
		}
		return []
	}

	const slash24 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/i.exec(trimmed)
	if (!slash24) {
		throw new Error(
			`Invalid Venstar scan CIDR "${cidr}". Use a.b.c.0/24 or a.b.c.d/32.`,
		)
	}
	const a = Number(slash24[1])
	const b = Number(slash24[2])
	const c = Number(slash24[3])
	if ([a, b, c].some((octet) => octet < 0 || octet > 255)) {
		throw new Error(`Invalid Venstar scan CIDR "${cidr}".`)
	}

	const ips: Array<string> = []
	for (let host = 1; host <= 254; host++) {
		ips.push(`${a}.${b}.${c}.${host}`)
	}
	return ips
}

function tryExpandVenstarScanCidr(cidr: string): Array<string> {
	try {
		return expandVenstarScanCidr(cidr)
	} catch (error) {
		console.warn(
			`Skipping Venstar scan CIDR "${cidr}": ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}

async function probeVenstarSubnet(cidrs: Array<string>): Promise<{
	locations: Array<VenstarLocation>
	infoByLocationUrl: Map<string, Record<string, unknown>>
	summary: VenstarSubnetProbeSummary
}> {
	const targets: Array<string> = []
	for (const cidr of cidrs) {
		targets.push(...tryExpandVenstarScanCidr(cidr))
	}

	const locations: Array<VenstarLocation> = []
	const infoByLocationUrl = new Map<string, Record<string, unknown>>()
	const seen = new Set<string>()
	const concurrency = targets.length

	let cursor = 0
	async function worker() {
		for (;;) {
			const index = cursor++
			if (index >= targets.length) return
			const ip = targets[index]
			if (!ip) continue

			const infoUrl = `http://${ip}/query/info`
			try {
				const info = await fetchJson<Record<string, unknown>>(infoUrl, 750)
				if (!looksLikeVenstarInfo(info)) continue
				const location = normalizeDeviceLocation(`http://${ip}/`)
				if (seen.has(location)) continue
				seen.add(location)
				locations.push({
					location,
					usn: null,
				})
				infoByLocationUrl.set(location, info)
			} catch {
				// Ignore non-Venstar hosts and transient host errors while scanning.
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()))

	return {
		locations,
		infoByLocationUrl,
		summary: {
			cidrs,
			hostsProbed: targets.length,
			venstarMatches: locations.length,
		},
	}
}

async function buildThermostatFromLocation(input: {
	location: VenstarLocation
	index: number
	cachedInfo?: Record<string, unknown>
}): Promise<{
	thermostat: VenstarDiscoveredThermostat
	diagnostic: VenstarInfoLookupDiagnostic
}> {
	const location = normalizeDeviceLocation(input.location.location)
	const infoUrl = buildInfoUrl(location)
	const ip = new URL(location).host
	try {
		const info =
			input.cachedInfo !== undefined
				? input.cachedInfo
				: await fetchJson<Record<string, unknown>>(infoUrl)
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
						typeof info['humidity'] === 'number'
							? info['humidity']
							: typeof info['hum'] === 'number'
								? info['hum']
								: null,
				},
				error: null,
			},
		}
	} catch (error) {
		return {
			thermostat: {
				name: `Venstar thermostat ${String(input.index + 1)}`,
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

async function discoverVenstarThermostats(
	config: HomeConnectorConfig,
): Promise<{
	thermostats: Array<VenstarDiscoveredThermostat>
	diagnostics: VenstarDiscoveryDiagnostics
}> {
	const now = new Date().toISOString()
	const subnet = await probeVenstarSubnet(config.venstarScanCidrs)
	const lookups = await Promise.all(
		subnet.locations.map((location, index) => {
			const cached = subnet.infoByLocationUrl.get(location.location)
			return buildThermostatFromLocation({
				location,
				index,
				...(cached !== undefined ? { cachedInfo: cached } : {}),
			})
		}),
	)

	return {
		thermostats: lookups.map((lookup) => lookup.thermostat),
		diagnostics: {
			protocol: 'subnet',
			discoveryUrl:
				config.venstarScanCidrs.length > 0
					? config.venstarScanCidrs.join(', ')
					: 'no-scan-cidrs',
			scannedAt: now,
			jsonResponse: null,
			ssdpHits: [],
			infoLookups: lookups.map((lookup) => lookup.diagnostic),
			subnetProbe: subnet.summary,
		},
	}
}

export async function scanVenstarThermostats(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = await discoverVenstarThermostats(config)
	setVenstarDiscoveredThermostats(state, result.thermostats)
	setVenstarDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
