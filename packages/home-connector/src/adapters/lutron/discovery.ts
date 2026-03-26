import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { type HomeConnectorConfig } from '../../config.ts'
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
	const matches = line.matchAll(/([A-Z0-9_]+)=((?:(?! [A-Z0-9_]+=).)+)/g)
	for (const match of matches) {
		const key = match[1]?.trim()
		const value = match[2]?.trim()
		if (!key || typeof value !== 'string') continue
		values[key] = decodeTxtValue(value)
	}
	return values
}

function parseBrowseOutput(output: string) {
	const services = new Set<string>()
	for (const line of output.split('\n')) {
		if (!line.includes('_lutron._tcp.')) continue
		const match = line.match(/_lutron\._tcp\.\s+(.*)$/)
		if (match?.[1]) {
			services.add(match[1].trim())
		}
	}
	return [...services]
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

async function parseLookupOutput(
	instanceName: string,
	output: string,
): Promise<DiscoveredLutronService> {
	let host: string | null = null
	let port: number | null = null
	let txt: Record<string, string> = {}

	for (const line of output.split('\n')) {
		if (line.includes('can be reached at')) {
			const match = line.match(/can be reached at\s+(\S+):(\d+)/)
			if (match) {
				host = match[1]?.replace(/\.$/, '') ?? null
				port = Number.parseInt(match[2] ?? '', 10)
			}
			continue
		}

		if (line.includes(' MACADDR=')) {
			txt = parseTxtLine(line)
		}
	}

	return {
		instanceName,
		host,
		port,
		address: await resolveAddress(host),
		txt,
		raw: output,
	}
}

async function runDnsSd(args: Array<string>, timeoutMs: number) {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn('dns-sd', args, {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		const timer = setTimeout(() => {
			child.kill('SIGINT')
		}, timeoutMs)
		child.stdout.on('data', (chunk) => {
			stdout += String(chunk)
		})
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk)
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on('close', () => {
			clearTimeout(timer)
			if (stderr.trim()) {
				stdout += `\n${stderr}`
			}
			resolve(stdout)
		})
	})
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
	let browseOutput = ''
	try {
		browseOutput = await runDnsSd(['-B', '_lutron._tcp', 'local.'], 4_000)
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error))
	}

	const serviceNames = parseBrowseOutput(browseOutput)
	const services: Array<DiscoveredLutronService> = []
	for (const serviceName of serviceNames) {
		try {
			const lookupOutput = await runDnsSd(
				['-L', serviceName, '_lutron._tcp', 'local.'],
				4_000,
			)
			services.push(await parseLookupOutput(serviceName, lookupOutput))
		} catch (error) {
			errors.push(
				`Failed to resolve ${serviceName}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
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
