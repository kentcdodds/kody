import { lookup } from 'node:dns/promises'
import { type HomeConnectorConfig } from '../../config.ts'
import { discoverMdnsServices } from '../../mdns.ts'
import {
	setLutronDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import {
	type LutronDiscoveredProcessor,
	type LutronDiscoveryDiagnostics,
	type LutronDiscoveryResult,
	type LutronDiscoveryServiceDiagnostic,
} from './types.ts'

type DiscoveredLutronService = LutronDiscoveryServiceDiagnostic
const defaultLutronLeapPort = 8081

function createProcessorId(input: {
	address: string | null
	host: string
	serialNumber: string | null
	macAddress: string | null
	instanceName: string
}) {
	const base =
		input.serialNumber ||
		input.macAddress ||
		input.address ||
		input.host ||
		input.instanceName
	return `lutron-${base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

function decodeTxtValue(value: string) {
	return value.replaceAll('\\ ', ' ').replaceAll('\\:', ':')
}

function parseTxtLine(line: string) {
	const values: Record<string, string> = {}
	const matches = line.matchAll(/([\w-]+)=((?:(?! [\w-]+=).)+)/gi)
	for (const match of matches) {
		const key = match[1]?.trim().toUpperCase()
		const value = match[2]?.trim()
		if (!key || typeof value !== 'string') continue
		values[key] = decodeTxtValue(value)
	}
	return values
}

async function resolveAddress(host: string | null) {
	if (!host) return null
	try {
		const result = await lookup(host, {
			family: 4,
		})
		return result.address
	} catch {
		return null
	}
}

async function parseResolvedService(
	service: Awaited<ReturnType<typeof discoverMdnsServices>>[number],
): Promise<DiscoveredLutronService> {
	const host = service.host?.replace(/\.$/, '') ?? null
	const txt = parseTxtLine(service.txtLine)
	return {
		instanceName: service.instanceName,
		host,
		port: service.port,
		address: service.address ?? (await resolveAddress(host)),
		txt,
		raw: service.raw,
	}
}

function mapDiscoveredServiceToProcessor(
	service: DiscoveredLutronService,
): LutronDiscoveredProcessor | null {
	if (!service.host || !service.port) {
		return null
	}

	const serialNumber = service.txt['SERNUM'] ?? null
	const macAddress = service.txt['MACADDR'] ?? null
	const systemType = service.txt['SYSTYPE'] ?? null
	const codeVersion = service.txt['CODEVER'] ?? null
	const deviceClass = service.txt['DEVCLASS'] ?? null
	const claimStatus = service.txt['CLAIM_STATUS'] ?? null
	const networkStatus = service.txt['NW_STATUS'] ?? null
	const firmwareStatus = service.txt['FW_STATUS'] ?? null
	const status = service.txt['ST_STATUS'] ?? null
	const name =
		service.instanceName.replace(/^Lutron Status(?: \(\d+\))?$/i, '').trim() ||
		service.host.replace(/\.local$/i, '')

	return {
		processorId: createProcessorId({
			address: service.address,
			host: service.host,
			serialNumber,
			macAddress,
			instanceName: service.instanceName,
		}),
		instanceName: service.instanceName,
		name,
		host: service.host,
		discoveryPort: service.port,
		leapPort: defaultLutronLeapPort,
		address: service.address,
		serialNumber,
		macAddress,
		systemType,
		codeVersion,
		deviceClass,
		claimStatus,
		networkStatus,
		firmwareStatus,
		status,
		lastSeenAt: new Date().toISOString(),
		rawDiscovery: {
			txt: service.txt,
		},
	}
}

async function discoverFromJson(
	discoveryUrl: string,
): Promise<LutronDiscoveryResult> {
	const response = await fetch(discoveryUrl)
	const payload = (await response.json()) as Record<string, unknown>
	const processors = Array.isArray(payload['processors'])
		? (payload['processors'] as Array<LutronDiscoveredProcessor>)
		: []
	return {
		processors,
		diagnostics: {
			protocol: 'json',
			discoveryUrl,
			scannedAt: new Date().toISOString(),
			jsonResponse: payload,
			services: [],
			errors: [],
		},
	}
}

async function discoverFromMdns(
	discoveryUrl: string,
): Promise<LutronDiscoveryResult> {
	const errors: Array<string> = []
	let services: Array<DiscoveredLutronService> = []
	try {
		const resolvedServices = await discoverMdnsServices({
			serviceType: '_lutron._tcp',
			timeoutMs: 4_000,
		})
		services = await Promise.all(
			resolvedServices.map((service) => parseResolvedService(service)),
		)
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error))
	}

	return {
		processors: services
			.map((service) => mapDiscoveredServiceToProcessor(service))
			.filter((service): service is LutronDiscoveredProcessor => service !== null),
		diagnostics: {
			protocol: 'mdns',
			discoveryUrl,
			scannedAt: new Date().toISOString(),
			jsonResponse: null,
			services,
			errors,
		},
	}
}

export async function scanLutronProcessors(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = config.lutronDiscoveryUrl.startsWith('http')
		? await discoverFromJson(config.lutronDiscoveryUrl)
		: await discoverFromMdns(config.lutronDiscoveryUrl)
	setLutronDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
