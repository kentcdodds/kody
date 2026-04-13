import { readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import path from 'node:path'

export type HomeConnectorConfig = {
	homeConnectorId: string
	workerBaseUrl: string
	workerSessionUrl: string
	workerWebSocketUrl: string
	sharedSecret: string | null
	rokuDiscoveryUrl: string
	samsungTvDiscoveryUrl: string
	lutronDiscoveryUrl: string
	sonosDiscoveryUrl: string
	bondDiscoveryUrl: string
	venstarDiscoveryUrl: string
	/**
	 * When SSDP finds nothing, probe `http://{ip}/query/info` on each host in
	 * these CIDRs (`VENSTAR_FALLBACK_CIDRS`, or auto from RFC1918 /24 interfaces
	 * unless `VENSTAR_AUTOSCAN_LAN=false`).
	 */
	venstarSubnetProbeCidrs: Array<string>
	venstarThermostats: Array<VenstarThermostatConfig>
	dataPath: string
	dbPath: string
	port: number
	mocksEnabled: boolean
}

export type VenstarThermostatConfig = {
	name: string
	ip: string
}

function trimTrailingSlash(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value
}

function createWorkerSessionUrl(
	workerBaseUrl: string,
	homeConnectorId: string,
) {
	const url = new URL(
		`/home/connectors/${encodeURIComponent(homeConnectorId)}`,
		`${trimTrailingSlash(workerBaseUrl)}/`,
	)
	return url.toString()
}

function createWorkerWebSocketUrl(workerSessionUrl: string) {
	const url = new URL(workerSessionUrl)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	return url.toString()
}

function resolveHomeConnectorDataPath() {
	return (
		process.env.HOME_CONNECTOR_DATA_PATH?.trim() ||
		path.join(homedir(), '.kody', 'home-connector')
	)
}

function resolveHomeConnectorDbPath(dataPath: string) {
	return (
		process.env.HOME_CONNECTOR_DB_PATH?.trim() ||
		path.join(dataPath, 'home-connector.sqlite')
	)
}

function normalizeVenstarThermostatConfig(
	entry: unknown,
): VenstarThermostatConfig | null {
	if (!entry || typeof entry !== 'object') return null
	const record = entry as Record<string, unknown>
	if (typeof record['name'] !== 'string' || typeof record['ip'] !== 'string') {
		return null
	}
	const name = record['name'].trim()
	const ip = record['ip'].trim()
	if (!name || !ip) return null
	return { name, ip }
}

function parseVenstarThermostats(
	raw: string,
	source: string,
): Array<VenstarThermostatConfig> {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		console.warn(
			`Invalid Venstar thermostat config JSON from ${source}: ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
	if (!Array.isArray(parsed)) {
		console.warn(
			`Invalid Venstar thermostat config from ${source}: expected an array.`,
		)
		return []
	}
	return parsed
		.map((entry) => normalizeVenstarThermostatConfig(entry))
		.filter((entry): entry is VenstarThermostatConfig => entry != null)
}

function resolveVenstarFallbackCidrs(): Array<string> {
	const raw = process.env.VENSTAR_FALLBACK_CIDRS?.trim()
	if (!raw) return []
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
}

function isPrivateRfc1918Ipv4(parts: Array<number>) {
	const [a, b] = parts
	return (
		a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
	)
}

function deriveVenstarAutoscanCidrs(): Array<string> {
	if (process.env.VENSTAR_AUTOSCAN_LAN === 'false') return []
	const cidrs = new Set<string>()
	for (const entries of Object.values(networkInterfaces())) {
		if (!entries) continue
		for (const entry of entries) {
			if (entry.internal || entry.family !== 'IPv4') continue
			const cidr = entry.cidr
			if (!cidr || !cidr.endsWith('/24')) continue
			const [addr] = cidr.split('/')
			if (!addr) continue
			const parts = addr.split('.').map((octet) => Number.parseInt(octet, 10))
			if (
				parts.length !== 4 ||
				parts.some((octet) => !Number.isFinite(octet))
			) {
				continue
			}
			if (!isPrivateRfc1918Ipv4(parts)) continue
			cidrs.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`)
		}
	}
	return [...cidrs]
}

function resolveVenstarThermostats(dataPath: string) {
	const envValue = process.env.VENSTAR_THERMOSTATS?.trim()
	if (envValue) {
		return parseVenstarThermostats(envValue, 'VENSTAR_THERMOSTATS')
	}
	const filePath = path.join(dataPath, 'venstar-thermostats.json')
	try {
		const fileValue = readFileSync(filePath, 'utf8').trim()
		if (!fileValue) return []
		return parseVenstarThermostats(fileValue, filePath)
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			'code' in error &&
			(error as { code?: string }).code === 'ENOENT'
		) {
			return []
		}
		throw error
	}
}

export function loadHomeConnectorConfig(): HomeConnectorConfig {
	const port = Number.parseInt(process.env.PORT ?? '4040', 10)
	const homeConnectorId = process.env.HOME_CONNECTOR_ID?.trim() || 'default'
	const workerBaseUrl =
		process.env.WORKER_BASE_URL?.trim() || 'http://localhost:3742'
	const mocksEnabled = process.env.MOCKS === 'true'
	const dataPath = resolveHomeConnectorDataPath()
	const workerSessionUrl = createWorkerSessionUrl(
		workerBaseUrl,
		homeConnectorId,
	)
	const explicitVenstarCidrs = resolveVenstarFallbackCidrs()
	const venstarSubnetProbeCidrs =
		explicitVenstarCidrs.length > 0
			? explicitVenstarCidrs
			: process.env.VENSTAR_AUTOSCAN_LAN !== 'false'
				? deriveVenstarAutoscanCidrs()
				: []
	return {
		homeConnectorId,
		workerBaseUrl,
		workerSessionUrl,
		workerWebSocketUrl: createWorkerWebSocketUrl(workerSessionUrl),
		sharedSecret: process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() || null,
		rokuDiscoveryUrl:
			process.env.ROKU_DISCOVERY_URL?.trim() || 'ssdp://239.255.255.250:1900',
		samsungTvDiscoveryUrl:
			process.env.SAMSUNG_TV_DISCOVERY_URL?.trim() ||
			'mdns://_samsungmsf._tcp.local',
		lutronDiscoveryUrl:
			process.env.LUTRON_DISCOVERY_URL?.trim() || 'mdns://_lutron._tcp.local',
		sonosDiscoveryUrl:
			process.env.SONOS_DISCOVERY_URL?.trim() ||
			'ssdp://239.255.255.250:1900?st=urn:schemas-upnp-org:device:ZonePlayer:1',
		bondDiscoveryUrl:
			process.env.BOND_DISCOVERY_URL?.trim() || 'mdns://_bond._tcp.local',
		venstarDiscoveryUrl:
			process.env.VENSTAR_DISCOVERY_URL?.trim() ||
			'ssdp://239.255.255.250:1900?st=venstar:thermostat:ecp&mx=2&timeoutMs=5000',
		venstarSubnetProbeCidrs,
		venstarThermostats: resolveVenstarThermostats(dataPath),
		dataPath,
		dbPath: resolveHomeConnectorDbPath(dataPath),
		port: Number.isFinite(port) ? port : 4040,
		mocksEnabled,
	}
}
