import net from 'node:net'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	setJellyfishDiscoveredControllers,
	setJellyfishDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import { probeJellyfishController } from './client.ts'
import {
	type JellyfishDiscoveredController,
	type JellyfishDiscoveryDiagnostics,
	type JellyfishProbeDiagnostic,
	jellyfishDefaultPort,
} from './types.ts'

function normalizeControllerId(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/-+/g, '-')
		.replace(/^-|-$/g, '')
}

function normalizeJsonDiscoveredController(
	entry: Record<string, unknown>,
	now: string,
): JellyfishDiscoveredController | null {
	const host =
		typeof entry['host'] === 'string' && entry['host'].trim()
			? entry['host'].trim()
			: null
	if (!host) return null
	const hostname =
		typeof entry['hostname'] === 'string' && entry['hostname'].trim()
			? entry['hostname'].trim()
			: host
	const controllerId =
		typeof entry['controllerId'] === 'string' && entry['controllerId'].trim()
			? entry['controllerId'].trim()
			: normalizeControllerId(hostname)
	const name =
		typeof entry['name'] === 'string' && entry['name'].trim()
			? entry['name'].trim()
			: hostname.replace(/\.local$/i, '')
	const rawDiscovery =
		entry['rawDiscovery'] &&
		typeof entry['rawDiscovery'] === 'object' &&
		!Array.isArray(entry['rawDiscovery'])
			? (entry['rawDiscovery'] as Record<string, unknown>)
			: entry
	return {
		controllerId,
		name,
		hostname,
		host,
		port:
			typeof entry['port'] === 'number' && Number.isFinite(entry['port'])
				? entry['port']
				: jellyfishDefaultPort,
		firmwareVersion:
			typeof entry['firmwareVersion'] === 'string' &&
			entry['firmwareVersion'].trim()
				? entry['firmwareVersion'].trim()
				: null,
		lastSeenAt:
			typeof entry['lastSeenAt'] === 'string' && entry['lastSeenAt'].trim()
				? entry['lastSeenAt'].trim()
				: now,
		rawDiscovery,
	}
}

async function discoverFromJson(input: { discoveryUrl: string }): Promise<{
	controllers: Array<JellyfishDiscoveredController>
	diagnostics: JellyfishDiscoveryDiagnostics
}> {
	const response = await fetch(input.discoveryUrl)
	if (!response.ok) {
		throw new Error(
			`JellyFish discovery JSON failed with status ${response.status}.`,
		)
	}
	const payload = (await response.json()) as Record<string, unknown>
	const rawControllers = Array.isArray(payload['controllers'])
		? (payload['controllers'] as Array<unknown>)
		: []
	const now = new Date().toISOString()
	return {
		controllers: rawControllers
			.filter(
				(entry): entry is Record<string, unknown> =>
					Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
			)
			.map((entry) => normalizeJsonDiscoveredController(entry, now))
			.filter(
				(entry): entry is JellyfishDiscoveredController => entry !== null,
			),
		diagnostics: {
			protocol: 'json',
			discoveryUrl: input.discoveryUrl,
			scannedAt: now,
			jsonResponse: payload,
			probeResults: [],
			subnetProbe: null,
		},
	}
}

function expandJellyfishScanCidr(cidr: string): Array<string> {
	const trimmed = cidr.trim()
	const single = /^(\d{1,3}(?:\.\d{1,3}){3})\/32$/i.exec(trimmed)
	if (single) return [single[1] ?? '']
	const slash24 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/i.exec(trimmed)
	if (!slash24) {
		throw new Error(
			`Invalid JellyFish scan CIDR "${cidr}". Use a.b.c.0/24 or a.b.c.d/32.`,
		)
	}
	const a = Number(slash24[1])
	const b = Number(slash24[2])
	const c = Number(slash24[3])
	if ([a, b, c].some((octet) => octet < 0 || octet > 255)) {
		throw new Error(`Invalid JellyFish scan CIDR "${cidr}".`)
	}
	const ips: Array<string> = []
	for (let host = 1; host <= 254; host++) {
		ips.push(`${a}.${b}.${c}.${host}`)
	}
	return ips
}

function tryExpandJellyfishScanCidr(cidr: string): Array<string> {
	try {
		return expandJellyfishScanCidr(cidr).filter(Boolean)
	} catch (error) {
		console.warn(
			`Skipping JellyFish scan CIDR "${cidr}": ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}

async function canConnectPort(host: string, port: number, timeoutMs: number) {
	return await new Promise<boolean>((resolve) => {
		const socket = new net.Socket()
		let settled = false
		const finish = (value: boolean) => {
			if (settled) return
			settled = true
			try {
				socket.destroy()
			} catch {
				// Ignore socket cleanup failures.
			}
			resolve(value)
		}
		socket.setTimeout(timeoutMs)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
		socket.connect(port, host)
	})
}

async function discoverFromSubnet(input: {
	config: HomeConnectorConfig
}): Promise<{
	controllers: Array<JellyfishDiscoveredController>
	diagnostics: JellyfishDiscoveryDiagnostics
}> {
	const targets: Array<string> = []
	for (const cidr of input.config.jellyfishScanCidrs) {
		targets.push(...tryExpandJellyfishScanCidr(cidr))
	}

	const controllers = new Map<string, JellyfishDiscoveredController>()
	const probeResults: Array<JellyfishProbeDiagnostic> = []
	const concurrency = Math.max(1, Math.min(64, targets.length || 1))
	const portTimeoutMs = 250
	const probeTimeoutMs = 1_500
	let cursor = 0
	let portOpenCount = 0

	async function worker() {
		for (;;) {
			const index = cursor++
			if (index >= targets.length) return
			const host = targets[index]
			if (!host) continue

			const portOpen = await canConnectPort(
				host,
				jellyfishDefaultPort,
				portTimeoutMs,
			)
			if (!portOpen) continue
			portOpenCount += 1

			try {
				const { controller, response } = await probeJellyfishController({
					host,
					port: jellyfishDefaultPort,
					timeoutMs: probeTimeoutMs,
					mocksEnabled: input.config.mocksEnabled,
				})
				controllers.set(controller.controllerId, controller)
				probeResults.push({
					host,
					port: jellyfishDefaultPort,
					matched: true,
					hostname: controller.hostname,
					response,
					error: null,
				})
			} catch (error) {
				probeResults.push({
					host,
					port: jellyfishDefaultPort,
					matched: false,
					hostname: null,
					response: null,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()))
	const now = new Date().toISOString()
	return {
		controllers: [...controllers.values()].sort((left, right) =>
			left.name.localeCompare(right.name),
		),
		diagnostics: {
			protocol: 'subnet',
			discoveryUrl:
				input.config.jellyfishScanCidrs.length > 0
					? input.config.jellyfishScanCidrs.join(', ')
					: 'no-scan-cidrs',
			scannedAt: now,
			jsonResponse: null,
			probeResults,
			subnetProbe: {
				cidrs: input.config.jellyfishScanCidrs,
				hostsProbed: targets.length,
				portOpenCount,
				jellyfishMatches: controllers.size,
			},
		},
	}
}

export async function scanJellyfishControllers(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = config.jellyfishDiscoveryUrl?.startsWith('http')
		? await discoverFromJson({ discoveryUrl: config.jellyfishDiscoveryUrl })
		: await discoverFromSubnet({ config })
	setJellyfishDiscoveredControllers(state, result.controllers)
	setJellyfishDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
