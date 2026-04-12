import { lookup } from 'node:dns/promises'
import { type HomeConnectorConfig } from '../../config.ts'
import { discoverMdnsServices } from '../../mdns.ts'
import {
	type HomeConnectorState,
	setBondDiscoveryDiagnostics,
} from '../../state.ts'
import { bondGetSysVersion, buildBondBaseUrl } from './api-client.ts'
import {
	type BondDiscoveredBridge,
	type BondDiscoveryDiagnostics,
	type BondDiscoveryServiceDiagnostic,
} from './types.ts'

function parseMdnsServiceType(discoveryUrl: string) {
	const trimmed = discoveryUrl.replace(/^mdns:\/\//i, '').replace(/\/$/, '')
	const withoutLocal = trimmed.replace(/\.local$/i, '')
	if (withoutLocal.includes('._tcp') || withoutLocal.includes('._udp')) {
		return withoutLocal
	}
	return `${withoutLocal}._tcp`
}

async function resolveAddress(host: string | null) {
	if (!host) return null
	const normalized = host.replace(/\.$/, '')
	try {
		const result = await lookup(normalized, { family: 4 })
		return result.address
	} catch {
		return null
	}
}

function mapServiceToDiagnostic(
	service: Awaited<ReturnType<typeof discoverMdnsServices>>[number],
): BondDiscoveryServiceDiagnostic {
	return {
		instanceName: service.instanceName,
		host: service.host?.replace(/\.$/, '') ?? null,
		port: service.port,
		address: service.address,
		txtLine: service.txtLine,
		raw: service.raw,
	}
}

type BondBridgeDiscoveryCore = {
	bridgeId: string
	bondid: string
	instanceName: string
	host: string
	port: number
	address: string | null
	lastSeenAt: string
	mdnsRaw: Record<string, unknown> | null
}

async function enrichBridgeFromVersion(
	bridge: BondBridgeDiscoveryCore,
): Promise<BondDiscoveredBridge> {
	const address = bridge.address ?? (await resolveAddress(bridge.host))
	const hostForUrl = address ?? bridge.host.replace(/\.$/, '')
	const baseUrl = buildBondBaseUrl(hostForUrl, bridge.port)
	let model: string | null = null
	let fwVer: string | null = null
	try {
		const version = await bondGetSysVersion({ baseUrl })
		model =
			typeof version['model'] === 'string'
				? (version['model'] as string)
				: typeof version['branding_profile'] === 'string'
					? (version['branding_profile'] as string)
					: null
		fwVer = typeof version['fw_ver'] === 'string' ? version['fw_ver'] : null
	} catch {
		// Version fetch is best-effort during discovery.
	}
	return {
		bridgeId: bridge.bridgeId,
		bondid: bridge.bondid,
		instanceName: bridge.instanceName,
		host: bridge.host,
		port: bridge.port,
		address: address ?? bridge.address,
		model,
		fwVer,
		lastSeenAt: bridge.lastSeenAt,
		rawDiscovery: {
			...(bridge.mdnsRaw ? { mdns: bridge.mdnsRaw } : {}),
			version: { model, fwVer },
		},
	}
}

async function discoverFromMdns(discoveryUrl: string): Promise<{
	bridges: Array<BondDiscoveredBridge>
	diagnostics: BondDiscoveryDiagnostics
}> {
	const errors: Array<string> = []
	const services: Array<BondDiscoveryServiceDiagnostic> = []
	let resolved: Awaited<ReturnType<typeof discoverMdnsServices>> = []
	try {
		const serviceType = parseMdnsServiceType(discoveryUrl)
		resolved = await discoverMdnsServices({
			serviceType,
			timeoutMs: 5_000,
		})
		services.push(...resolved.map(mapServiceToDiagnostic))
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error))
	}

	const now = new Date().toISOString()
	const partialBridges: Array<BondBridgeDiscoveryCore> = []
	for (const service of resolved) {
		const host = service.host?.replace(/\.$/, '') ?? ''
		const port = service.port ?? 80
		if (!host) continue
		const bondid =
			service.instanceName || host.replace(/\.local$/i, '') || `bond-${host}`
		const bridgeId = bondid
		const address = service.address ?? (await resolveAddress(host))
		let mdnsRaw: Record<string, unknown> | null = null
		try {
			mdnsRaw = JSON.parse(service.raw) as Record<string, unknown>
		} catch {
			mdnsRaw = null
		}
		partialBridges.push({
			bridgeId,
			bondid,
			instanceName: service.instanceName,
			host,
			port,
			address,
			lastSeenAt: now,
			mdnsRaw,
		})
	}

	const bridges = await Promise.all(
		partialBridges.map((bridge) => enrichBridgeFromVersion(bridge)),
	)

	return {
		bridges,
		diagnostics: {
			protocol: 'mdns',
			discoveryUrl,
			scannedAt: now,
			jsonResponse: null,
			services,
			errors,
		},
	}
}

async function discoverFromJson(discoveryUrl: string): Promise<{
	bridges: Array<BondDiscoveredBridge>
	diagnostics: BondDiscoveryDiagnostics
}> {
	const errors: Array<string> = []
	const now = new Date().toISOString()
	let jsonResponse: Record<string, unknown> | null = null
	let bridges: Array<BondDiscoveredBridge> = []
	try {
		const response = await fetch(discoveryUrl)
		jsonResponse = (await response.json()) as Record<string, unknown>
		const raw = jsonResponse['bridges']
		if (!Array.isArray(raw)) {
			errors.push('Discovery JSON did not contain a bridges array.')
		} else {
			bridges = raw
				.map((entry) => {
					const row = entry as Record<string, unknown>
					const bondid = String(row['bondid'] ?? row['bridgeId'] ?? '')
					const host = String(row['host'] ?? '')
					if (!bondid || !host) return null
					const port =
						typeof row['port'] === 'number' && Number.isFinite(row['port'])
							? row['port']
							: 80
					return {
						bridgeId: bondid,
						bondid,
						instanceName: String(row['instanceName'] ?? bondid),
						host,
						port,
						address: typeof row['address'] === 'string' ? row['address'] : null,
						model: typeof row['model'] === 'string' ? row['model'] : null,
						fwVer: typeof row['fwVer'] === 'string' ? row['fwVer'] : null,
						lastSeenAt: now,
						rawDiscovery: row,
					} satisfies BondDiscoveredBridge
				})
				.filter((entry): entry is BondDiscoveredBridge => entry !== null)
		}
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error))
	}

	return {
		bridges,
		diagnostics: {
			protocol: 'json',
			discoveryUrl,
			scannedAt: now,
			jsonResponse,
			services: [],
			errors,
		},
	}
}

export async function scanBondBridges(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = config.bondDiscoveryUrl.startsWith('http')
		? await discoverFromJson(config.bondDiscoveryUrl)
		: await discoverFromMdns(config.bondDiscoveryUrl)
	setBondDiscoveryDiagnostics(state, result.diagnostics)
	return result.bridges
}
