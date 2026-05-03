import { homedir, networkInterfaces } from 'node:os'
import path from 'node:path'

export type HomeConnectorConfig = {
	homeConnectorId: string
	workerBaseUrl: string
	workerSessionUrl: string
	workerWebSocketUrl: string
	sharedSecret: string | null
	/**
	 * Access Networks / RUCKUS Unleashed discovery probes these CIDRs over HTTPS.
	 * When unset, the connector derives private `/24` networks from local IPv4
	 * interfaces. `ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS` can override the derived
	 * list.
	 */
	accessNetworksUnleashedScanCidrs: Array<string>
	accessNetworksUnleashedAllowInsecureTls: boolean
	accessNetworksUnleashedRequestTimeoutMs: number
	islandRouterHost: string | null
	islandRouterPort: number
	islandRouterUsername: string | null
	islandRouterPrivateKeyPath: string | null
	islandRouterKnownHostsPath: string | null
	islandRouterHostFingerprint: string | null
	islandRouterCommandTimeoutMs: number
	rokuDiscoveryUrl: string
	samsungTvDiscoveryUrl: string
	lutronDiscoveryUrl: string
	sonosDiscoveryUrl: string
	bondDiscoveryUrl: string
	bondRequestPaceMs: number
	bondCircuitBreakerCooldownMs: number
	jellyfishDiscoveryUrl: string | null
	/**
	 * Venstar discovery uses direct HTTP probes to `/query/info` across these
	 * CIDRs. When unset, the connector derives private `/24` networks from local
	 * interfaces. `VENSTAR_SCAN_CIDRS` can override the derived list.
	 */
	venstarScanCidrs: Array<string>
	/**
	 * JellyFish discovery uses direct WebSocket probes to `ws://<host>:9000`
	 * across these CIDRs unless `JELLYFISH_DISCOVERY_URL` points to a JSON
	 * discovery feed.
	 */
	jellyfishScanCidrs: Array<string>
	dataPath: string
	dbPath: string
	port: number
	mocksEnabled: boolean
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

function resolveScanCidrsFromEnv(envVar: string): Array<string> {
	const raw = process.env[envVar]?.trim()
	if (!raw) return []
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
}

function resolveNonNegativeIntegerFromEnv(envVar: string, fallback: number) {
	const raw = process.env[envVar]?.trim()
	if (!raw) return fallback
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseStrictIntegerEnv(value: string | undefined) {
	const trimmed = value?.trim()
	if (!trimmed) return null
	if (!/^\d+$/.test(trimmed)) return null
	const parsed = Number(trimmed)
	if (!Number.isInteger(parsed)) return null
	return parsed
}

function isPrivateRfc1918Ipv4(parts: Array<number>) {
	const [a, b] = parts
	return (
		a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
	)
}

function parseIpv4Parts(value: string) {
	const parts = value.split('.').map((octet) => Number.parseInt(octet, 10))
	if (
		parts.length !== 4 ||
		parts.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)
	) {
		return null
	}
	return parts
}

function ipv4PartsToInt(parts: Array<number>) {
	return (
		(((parts[0] ?? 0) << 24) |
			((parts[1] ?? 0) << 16) |
			((parts[2] ?? 0) << 8) |
			(parts[3] ?? 0)) >>>
		0
	)
}

function ipv4IntToCidr24(value: number) {
	const a = (value >>> 24) & 255
	const b = (value >>> 16) & 255
	const c = (value >>> 8) & 255
	return `${a}.${b}.${c}.0/24`
}

function derivePrivateAutoscanCidrsFromCidr(cidr: string): Array<string> {
	const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim())
	if (!match) return []
	const address = match[1] ?? ''
	const prefix = Number.parseInt(match[2] ?? '', 10)
	if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return []
	const parts = parseIpv4Parts(address)
	if (!parts || !isPrivateRfc1918Ipv4(parts)) return []
	if (prefix === 32) return [`${address}/32`]
	if (prefix >= 24) return [`${parts[0]}.${parts[1]}.${parts[2]}.0/24`]

	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
	const addressInt = ipv4PartsToInt(parts)
	const networkInt = addressInt & mask
	const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0
	const firstCidr24 = networkInt & 0xffffff00
	const lastCidr24 = broadcastInt & 0xffffff00
	const derived: Array<string> = []
	for (let current = firstCidr24; current <= lastCidr24; current += 256) {
		derived.push(ipv4IntToCidr24(current))
	}
	if (derived.length > 16) {
		console.warn(
			`Skipping broad autoscan CIDR "${cidr}" because it expands to ${derived.length} /24 scan blocks. Set a smaller scan range explicitly.`,
		)
		return []
	}
	return derived
}

export function derivePrivateAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	const cidrs = new Set<string>()
	for (const entries of Object.values(interfaces)) {
		if (!entries) continue
		for (const entry of entries) {
			if (entry.internal || entry.family !== 'IPv4') continue
			const cidr = entry.cidr
			if (!cidr) continue
			for (const derived of derivePrivateAutoscanCidrsFromCidr(cidr)) {
				cidrs.add(derived)
			}
		}
	}
	return [...cidrs]
}

export function deriveVenstarAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	return derivePrivateAutoscanCidrsFromInterfaces(interfaces)
}

export function deriveAccessNetworksUnleashedAutoscanCidrsFromInterfaces(
	interfaces: ReturnType<typeof networkInterfaces>,
) {
	return derivePrivateAutoscanCidrsFromInterfaces(interfaces)
}

function deriveVenstarAutoscanCidrs() {
	return deriveVenstarAutoscanCidrsFromInterfaces(networkInterfaces())
}

function deriveAccessNetworksUnleashedAutoscanCidrs() {
	return deriveAccessNetworksUnleashedAutoscanCidrsFromInterfaces(
		networkInterfaces(),
	)
}

function deriveJellyfishAutoscanCidrs() {
	return derivePrivateAutoscanCidrsFromInterfaces(networkInterfaces())
}

export function loadHomeConnectorConfig(): HomeConnectorConfig {
	const port = Number.parseInt(process.env.PORT ?? '4040', 10)
	const islandRouterPort = parseStrictIntegerEnv(process.env.ISLAND_ROUTER_PORT)
	const islandRouterCommandTimeoutMs = Number.parseInt(
		process.env.ISLAND_ROUTER_COMMAND_TIMEOUT_MS ?? '8000',
		10,
	)
	const accessNetworksUnleashedRequestTimeoutMs = Number.parseInt(
		process.env.ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS ?? '8000',
		10,
	)
	const homeConnectorId = process.env.HOME_CONNECTOR_ID?.trim() || 'default'
	const workerBaseUrl =
		process.env.WORKER_BASE_URL?.trim() || 'http://localhost:3742'
	const mocksEnabled = process.env.MOCKS === 'true'
	const dataPath = resolveHomeConnectorDataPath()
	const workerSessionUrl = createWorkerSessionUrl(
		workerBaseUrl,
		homeConnectorId,
	)
	const explicitAccessNetworksUnleashedCidrs = resolveScanCidrsFromEnv(
		'ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS',
	)
	const accessNetworksUnleashedScanCidrs =
		explicitAccessNetworksUnleashedCidrs.length > 0
			? explicitAccessNetworksUnleashedCidrs
			: deriveAccessNetworksUnleashedAutoscanCidrs()
	const explicitVenstarCidrs = resolveScanCidrsFromEnv('VENSTAR_SCAN_CIDRS')
	const venstarScanCidrs =
		explicitVenstarCidrs.length > 0
			? explicitVenstarCidrs
			: deriveVenstarAutoscanCidrs()
	const explicitJellyfishCidrs = resolveScanCidrsFromEnv('JELLYFISH_SCAN_CIDRS')
	const jellyfishScanCidrs =
		explicitJellyfishCidrs.length > 0
			? explicitJellyfishCidrs
			: deriveJellyfishAutoscanCidrs()
	return {
		homeConnectorId,
		workerBaseUrl,
		workerSessionUrl,
		workerWebSocketUrl: createWorkerWebSocketUrl(workerSessionUrl),
		sharedSecret: process.env.HOME_CONNECTOR_SHARED_SECRET?.trim() || null,
		accessNetworksUnleashedScanCidrs,
		accessNetworksUnleashedAllowInsecureTls:
			process.env.ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS === 'true',
		accessNetworksUnleashedRequestTimeoutMs:
			Number.isFinite(accessNetworksUnleashedRequestTimeoutMs) &&
			accessNetworksUnleashedRequestTimeoutMs >= 1000
				? accessNetworksUnleashedRequestTimeoutMs
				: 8000,
		islandRouterHost: process.env.ISLAND_ROUTER_HOST?.trim() || null,
		islandRouterPort:
			islandRouterPort != null &&
			islandRouterPort >= 1 &&
			islandRouterPort <= 65535
				? islandRouterPort
				: 22,
		islandRouterUsername: process.env.ISLAND_ROUTER_USERNAME?.trim() || null,
		islandRouterPrivateKeyPath:
			process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH?.trim() || null,
		islandRouterKnownHostsPath:
			process.env.ISLAND_ROUTER_KNOWN_HOSTS_PATH?.trim() || null,
		islandRouterHostFingerprint:
			process.env.ISLAND_ROUTER_HOST_FINGERPRINT?.trim() || null,
		islandRouterCommandTimeoutMs:
			Number.isFinite(islandRouterCommandTimeoutMs) &&
			islandRouterCommandTimeoutMs >= 1000
				? islandRouterCommandTimeoutMs
				: 8000,
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
		bondRequestPaceMs: resolveNonNegativeIntegerFromEnv(
			'BOND_REQUEST_PACE_MS',
			500,
		),
		bondCircuitBreakerCooldownMs: resolveNonNegativeIntegerFromEnv(
			'BOND_CIRCUIT_BREAKER_COOLDOWN_MS',
			60_000,
		),
		jellyfishDiscoveryUrl: process.env.JELLYFISH_DISCOVERY_URL?.trim() || null,
		venstarScanCidrs,
		jellyfishScanCidrs,
		dataPath,
		dbPath: resolveHomeConnectorDbPath(dataPath),
		port: Number.isFinite(port) ? port : 4040,
		mocksEnabled,
	}
}
