/**
 * Discovery for Tesla Backup Gateway 2 / Powerwall+ leader gateways on the
 * local network.
 *
 * Identification combines three signals:
 *
 * 1. TCP port 443 reachability for each candidate IP.
 * 2. The TLS certificate. Tesla Energy devices present a self-signed cert
 *    where `O=Tesla, OU=Tesla Energy Products` and the SAN list contains
 *    `DNS:teg, DNS:powerwall` (and on newer firmwares `DNS:powerpack`).
 *    The cert alone identifies the device as Tesla but cannot distinguish a
 *    BGW2 leader from a Powerwall unit because both expose identical SANs.
 * 3. The MAC OUI from the local ARP cache. Backup Gateway 2 leaders use OUI
 *    `90:03:71`; individual Powerwall units use `00:d6:cb`. The OUI is the
 *    only reliable way to demote Powerwalls so callers only see leaders,
 *    since only the leader answers `/api/...` calls.
 *
 * As a final fallback we hit `POST /api/login/Basic` with a deliberately bad
 * password. A real Tesla gateway responds with HTTP 401 + a JSON body that
 * includes the substring `"Bad Credentials"`. Anything else is treated as
 * "not a Tesla gateway".
 */
import { exec } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import { connect as tlsConnect } from 'node:tls'
import { Socket } from 'node:net'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import {
	derivePrivateAutoscanCidrsFromInterfaces,
	type HomeConnectorConfig,
} from '../../config.ts'
import {
	setTeslaGatewayDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import {
	type TeslaGatewayCertSummary,
	type TeslaGatewayDiscoveredGateway,
	type TeslaGatewayDiscoveryResult,
	type TeslaGatewayHostProbe,
} from './types.ts'

const execAsync = promisify(exec)

const DEFAULT_PORT = 443
const TCP_PROBE_TIMEOUT_MS = 1_000
const TLS_PROBE_TIMEOUT_MS = 3_000
const LOGIN_PROBE_TIMEOUT_MS = 4_000
const SUBNET_MAX_HOSTS = 254
const TESLA_LEADER_OUIS = new Set(['90:03:71'])
const TESLA_POWERWALL_OUIS = new Set(['00:d6:cb'])

const insecureAgent = new HttpsAgent({
	rejectUnauthorized: false,
	keepAlive: false,
})

function expandSlash24(cidr: string): Array<string> {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(cidr.trim())
	if (!match) {
		const single = /^(\d{1,3}(?:\.\d{1,3}){3})\/32$/.exec(cidr.trim())
		if (single) return [single[1] ?? '']
		return []
	}
	const a = Number(match[1])
	const b = Number(match[2])
	const c = Number(match[3])
	const ips: Array<string> = []
	for (let host = 1; host <= SUBNET_MAX_HOSTS; host++) {
		ips.push(`${a}.${b}.${c}.${host}`)
	}
	return ips
}

function tcpProbe(host: string, port: number, timeoutMs: number) {
	return new Promise<boolean>((resolve) => {
		const socket = new Socket()
		const finish = (open: boolean) => {
			socket.destroy()
			resolve(open)
		}
		socket.setTimeout(timeoutMs)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
		socket.connect(port, host)
	})
}

function summarizeCert(input: {
	subject?: { CN?: string; O?: string; OU?: string }
	issuer?: { CN?: string; O?: string }
	subjectaltname?: string
	fingerprint256?: string
}): TeslaGatewayCertSummary {
	return {
		subjectCommonName: input.subject?.CN ?? null,
		subjectOrganization: input.subject?.O ?? null,
		subjectOrganizationalUnit: input.subject?.OU ?? null,
		issuerCommonName: input.issuer?.CN ?? null,
		issuerOrganization: input.issuer?.O ?? null,
		subjectAltName: input.subjectaltname ?? null,
		fingerprint256: input.fingerprint256 ?? null,
	}
}

function tlsProbeCert(host: string, port: number, timeoutMs: number) {
	return new Promise<TeslaGatewayCertSummary | null>((resolve) => {
		let settled = false
		const socket = tlsConnect({
			host,
			port,
			rejectUnauthorized: false,
			servername: host,
			timeout: timeoutMs,
		})
		const finish = (cert: TeslaGatewayCertSummary | null) => {
			if (settled) return
			settled = true
			socket.destroy()
			resolve(cert)
		}
		socket.once('secureConnect', () => {
			const peerCert = socket.getPeerCertificate(false)
			if (!peerCert || Object.keys(peerCert).length === 0) {
				finish(null)
				return
			}
			finish(
				summarizeCert({
					subject: peerCert.subject as
						| { CN?: string; O?: string; OU?: string }
						| undefined,
					issuer: peerCert.issuer as { CN?: string; O?: string } | undefined,
					subjectaltname: peerCert.subjectaltname,
					fingerprint256: peerCert.fingerprint256,
				}),
			)
		})
		socket.once('timeout', () => finish(null))
		socket.once('error', () => finish(null))
	})
}

function isTeslaCert(cert: TeslaGatewayCertSummary | null) {
	if (!cert) return false
	const o = (cert.subjectOrganization ?? '').toLowerCase()
	const ou = (cert.subjectOrganizationalUnit ?? '').toLowerCase()
	const san = (cert.subjectAltName ?? '').toLowerCase()
	if (o.includes('tesla')) return true
	if (ou.includes('tesla energy products')) return true
	return san.includes('dns:teg') || san.includes('dns:powerwall')
}

async function readArpCache(): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	try {
		const result = await execAsync('arp -an', { timeout: 4_000 })
		const lines = result.stdout.split('\n')
		for (const line of lines) {
			const ipMatch = /\((\d{1,3}(?:\.\d{1,3}){3})\)/.exec(line)
			const macMatch = /([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i.exec(line)
			if (!ipMatch || !macMatch) continue
			const ip = ipMatch[1] ?? ''
			const macRaw = macMatch[1] ?? ''
			const macNormalized = macRaw
				.toLowerCase()
				.split(':')
				.map((segment) => segment.padStart(2, '0'))
				.join(':')
			if (ip.length > 0 && macNormalized.length === 17) {
				map.set(ip, macNormalized)
			}
		}
	} catch {
		// arp not available (e.g. sandbox, container) -> no MAC enrichment.
	}
	return map
}

function ouiFromMac(mac: string | null) {
	if (!mac) return null
	const parts = mac.split(':')
	if (parts.length < 3) return null
	return `${parts[0]}:${parts[1]}:${parts[2]}`
}

function probeLoginEndpoint(host: string, port: number, timeoutMs: number) {
	return new Promise<{ status: number; bodyPreview: string | null } | null>(
		(resolve) => {
			let settled = false
			const finish = (
				value: { status: number; bodyPreview: string | null } | null,
			) => {
				if (settled) return
				settled = true
				resolve(value)
			}
			const req = httpsRequest(
				{
					host,
					port,
					method: 'POST',
					path: '/api/login/Basic',
					headers: {
						'Content-Type': 'application/json',
						'User-Agent': 'kody-home-connector/tesla-gateway-discovery',
					},
					agent: insecureAgent,
					timeout: timeoutMs,
				},
				(res) => {
					const chunks: Array<Buffer> = []
					res.on('data', (chunk: Buffer) => chunks.push(chunk))
					res.on('end', () => {
						const body = Buffer.concat(chunks).toString('utf8')
						finish({
							status: res.statusCode ?? 0,
							bodyPreview: body.slice(0, 200) || null,
						})
					})
					res.on('error', () => finish(null))
				},
			)
			req.on('timeout', () => {
				req.destroy()
				finish(null)
			})
			req.on('error', () => finish(null))
			req.write(
				JSON.stringify({
					username: 'customer',
					email: 'discovery@kody.local',
					password: '__discovery_probe__',
				}),
			)
			req.end()
		},
	)
}

/**
 * Decide whether an identified Tesla host should be treated as a leader.
 *
 * Both BGW2 leaders and Powerwall units present identical SANs
 * (`DNS:teg, DNS:powerwall, DNS:powerpack`), so cert content alone cannot
 * distinguish them. The MAC OUI is the only definitive signal.
 *
 * Rules in priority order:
 *
 *   1. OUI matches a known BGW2 leader OUI -> leader.
 *   2. OUI matches a Powerwall OUI -> not a leader.
 *   3. ARP gave us no MAC at all but the cert is Tesla -> treat as a
 *      candidate leader. We prefer surfacing a candidate over silently
 *      dropping a real leader hidden behind ARP issues. A subsequent
 *      login-endpoint probe may further refine.
 *   4. Otherwise -> not a leader.
 */
function decideLeaderStatus(input: {
	certIsTesla: boolean
	macAddress: string | null
	ouiIsLeader: boolean
	ouiIsPowerwall: boolean
}): boolean {
	if (input.ouiIsLeader) return true
	if (input.ouiIsPowerwall) return false
	if (input.macAddress === null && input.certIsTesla) return true
	return false
}

function probeLooksLikeTesla(probe: {
	status: number
	bodyPreview: string | null
}) {
	if (probe.status !== 401 && probe.status !== 403) return false
	const preview = (probe.bodyPreview ?? '').toLowerCase()
	if (
		preview.includes('bad credentials') ||
		preview.includes('login') ||
		preview.includes('unauthorized')
	) {
		return true
	}
	// Some firmwares return an empty 401 body; trust 401 + Tesla cert combination
	// done at a higher level.
	return probe.bodyPreview === null || probe.bodyPreview === ''
}

async function probeHost(input: {
	host: string
	port: number
	arpCache: Map<string, string>
	tcpOpen?: boolean
}): Promise<TeslaGatewayHostProbe> {
	const tcpOpen =
		input.tcpOpen ??
		(await tcpProbe(input.host, input.port, TCP_PROBE_TIMEOUT_MS))
	if (!tcpOpen) {
		return {
			host: input.host,
			port: input.port,
			tcpOpen: false,
			cert: null,
			macAddress: input.arpCache.get(input.host) ?? null,
			macOui: ouiFromMac(input.arpCache.get(input.host) ?? null),
			identifiedAsTesla: false,
			identifiedAsLeader: false,
			loginEndpointResponse: null,
			error: null,
		}
	}
	const cert = await tlsProbeCert(input.host, input.port, TLS_PROBE_TIMEOUT_MS)
	const macAddress = input.arpCache.get(input.host) ?? null
	const macOui = ouiFromMac(macAddress)
	const certIsTesla = isTeslaCert(cert)
	const ouiIsLeader = macOui !== null && TESLA_LEADER_OUIS.has(macOui)
	const ouiIsPowerwall = macOui !== null && TESLA_POWERWALL_OUIS.has(macOui)
	let identifiedAsTesla = certIsTesla || ouiIsLeader || ouiIsPowerwall
	let identifiedAsLeader = decideLeaderStatus({
		certIsTesla,
		macAddress,
		ouiIsLeader,
		ouiIsPowerwall,
	})
	let loginEndpointResponse: TeslaGatewayHostProbe['loginEndpointResponse'] =
		null
	if (certIsTesla && !ouiIsPowerwall) {
		loginEndpointResponse = await probeLoginEndpoint(
			input.host,
			input.port,
			LOGIN_PROBE_TIMEOUT_MS,
		)
		if (loginEndpointResponse && probeLooksLikeTesla(loginEndpointResponse)) {
			identifiedAsTesla = true
			// Note: a 401 / "Bad Credentials" response does not by itself prove
			// leader status (Powerwall units sometimes respond identically),
			// so we only upgrade to leader when the OUI confirms it OR we have
			// no OUI signal at all to contradict the cert.
			if (ouiIsLeader || (macAddress === null && !ouiIsPowerwall)) {
				identifiedAsLeader = true
			}
		}
	}
	return {
		host: input.host,
		port: input.port,
		tcpOpen: true,
		cert,
		macAddress,
		macOui,
		identifiedAsTesla,
		identifiedAsLeader,
		loginEndpointResponse,
		error: null,
	}
}

function buildGatewayId(input: { host: string; macAddress: string | null }) {
	const base = input.macAddress ?? input.host
	return `tesla-gateway-${base.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

function probeToGateway(
	probe: TeslaGatewayHostProbe,
): TeslaGatewayDiscoveredGateway | null {
	if (!probe.identifiedAsTesla || !probe.identifiedAsLeader) return null
	return {
		gatewayId: buildGatewayId({
			host: probe.host,
			macAddress: probe.macAddress,
		}),
		host: probe.host,
		port: probe.port,
		din: null,
		serialNumber: null,
		macAddress: probe.macAddress,
		macOui: probe.macOui,
		cert: probe.cert,
		firmwareVersion: null,
		role: 'leader',
		lastSeenAt: new Date().toISOString(),
	}
}

function dedupeProbeTargets(targets: Array<string>) {
	const seen = new Set<string>()
	const result: Array<string> = []
	for (const target of targets) {
		const trimmed = target.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		result.push(trimmed)
	}
	return result
}

function mergeArpMaps(maps: Array<Map<string, string>>) {
	const merged = new Map<string, string>()
	for (const map of maps) {
		for (const [ip, mac] of map) merged.set(ip, mac)
	}
	return merged
}

async function scanSubnets(input: {
	cidrs: Array<string>
	port: number
}): Promise<{
	probes: Array<TeslaGatewayHostProbe>
	subnetSummary: {
		cidrs: Array<string>
		hostsProbed: number
		teslaMatches: number
		leaderMatches: number
	}
}> {
	const targets = dedupeProbeTargets(
		input.cidrs.flatMap((cidr) => expandSlash24(cidr)),
	)
	// Phase 1: snapshot the ARP cache up front (may already be partially warm).
	const arpBefore = await readArpCache()

	// Phase 2: TCP-probe every target in parallel. Successful TCP connects
	// trigger ARP resolution at the kernel level, so the second ARP read
	// below will see MAC addresses for every reachable host.
	const tcpResults = new Map<string, boolean>()
	let cursor = 0
	const tcpConcurrency = Math.min(64, Math.max(8, targets.length))
	async function tcpWorker() {
		while (cursor < targets.length) {
			const index = cursor++
			const host = targets[index]
			if (!host) continue
			const open = await tcpProbe(host, input.port, TCP_PROBE_TIMEOUT_MS)
			tcpResults.set(host, open)
		}
	}
	await Promise.all(Array.from({ length: tcpConcurrency }, () => tcpWorker()))

	// Phase 3: re-read ARP cache now that TCP probes have populated it. Merge
	// with the pre-snapshot in case some entries were already warm but expired
	// during the scan.
	const arpAfter = await readArpCache()
	const arpCache = mergeArpMaps([arpBefore, arpAfter])

	// Phase 4: detailed probe (TLS cert + optional login endpoint) only for
	// hosts where TCP was open. Lower concurrency keeps login-endpoint probes
	// from looking like a flood to per-IP rate limiters.
	const openHosts = targets.filter((host) => tcpResults.get(host) === true)
	const probes: Array<TeslaGatewayHostProbe> = []
	let detailCursor = 0
	const detailConcurrency = Math.min(8, Math.max(2, openHosts.length))
	async function detailWorker() {
		while (detailCursor < openHosts.length) {
			const index = detailCursor++
			const host = openHosts[index]
			if (!host) continue
			try {
				const probe = await probeHost({
					host,
					port: input.port,
					arpCache,
					tcpOpen: true,
				})
				probes.push(probe)
			} catch (error) {
				probes.push({
					host,
					port: input.port,
					tcpOpen: true,
					cert: null,
					macAddress: arpCache.get(host) ?? null,
					macOui: ouiFromMac(arpCache.get(host) ?? null),
					identifiedAsTesla: false,
					identifiedAsLeader: false,
					loginEndpointResponse: null,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}
	await Promise.all(
		Array.from({ length: detailConcurrency }, () => detailWorker()),
	)

	const teslaMatches = probes.filter((p) => p.identifiedAsTesla).length
	const leaderMatches = probes.filter((p) => p.identifiedAsLeader).length
	return {
		probes,
		subnetSummary: {
			cidrs: input.cidrs,
			hostsProbed: targets.length,
			teslaMatches,
			leaderMatches,
		},
	}
}

function resolveScanCidrs(config: HomeConnectorConfig): Array<string> {
	if (config.teslaGatewayScanCidrs.length > 0) {
		return config.teslaGatewayScanCidrs
	}
	return derivePrivateAutoscanCidrsFromInterfaces(networkInterfaces())
}

async function discoverFromJson(
	discoveryUrl: string,
): Promise<TeslaGatewayDiscoveryResult> {
	const errors: Array<string> = []
	let payload: Record<string, unknown> | null = null
	try {
		const response = await fetch(discoveryUrl)
		if (!response.ok) {
			errors.push(
				`Tesla discovery feed returned HTTP ${response.status} for ${discoveryUrl}`,
			)
		} else {
			payload = (await response.json()) as Record<string, unknown>
		}
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error))
	}
	const gateways = Array.isArray(payload?.['gateways'])
		? (payload['gateways'] as Array<TeslaGatewayDiscoveredGateway>)
		: []
	return {
		gateways,
		diagnostics: {
			protocol: 'json',
			discoveryUrl,
			scannedAt: new Date().toISOString(),
			jsonResponse: payload,
			hostProbes: [],
			subnetProbe: null,
			errors,
		},
	}
}

async function discoverFromSubnet(
	config: HomeConnectorConfig,
): Promise<TeslaGatewayDiscoveryResult> {
	const cidrs = resolveScanCidrs(config)
	const port = DEFAULT_PORT
	const errors: Array<string> = []
	const { probes, subnetSummary } = await scanSubnets({ cidrs, port })
	const gateways = probes
		.map((probe) => probeToGateway(probe))
		.filter(
			(gateway): gateway is TeslaGatewayDiscoveredGateway => gateway !== null,
		)

	return {
		gateways,
		diagnostics: {
			protocol: 'subnet',
			discoveryUrl: cidrs.length > 0 ? cidrs.join(', ') : 'no-scan-cidrs',
			scannedAt: new Date().toISOString(),
			jsonResponse: null,
			hostProbes: probes,
			subnetProbe: subnetSummary,
			errors,
		},
	}
}

export async function scanTeslaGateways(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
): Promise<TeslaGatewayDiscoveryResult> {
	const url = config.teslaGatewayDiscoveryUrl
	const result =
		url && url.startsWith('http')
			? await discoverFromJson(url)
			: await discoverFromSubnet(config)
	setTeslaGatewayDiscoveryDiagnostics(state, result.diagnostics)
	return result
}

export const __testing = {
	decideLeaderStatus,
	expandSlash24,
	isTeslaCert,
	probeLooksLikeTesla,
	ouiFromMac,
	TESLA_LEADER_OUIS,
	TESLA_POWERWALL_OUIS,
}
