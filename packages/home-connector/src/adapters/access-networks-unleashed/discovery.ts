import { Agent } from 'undici'
import { type HomeConnectorConfig } from '../../config.ts'
import {
	setAccessNetworksUnleashedDiscoveryDiagnostics,
	type HomeConnectorState,
} from '../../state.ts'
import {
	type AccessNetworksUnleashedDiscoveredController,
	type AccessNetworksUnleashedDiscoveryDiagnostics,
	type AccessNetworksUnleashedDiscoveryResult,
	type AccessNetworksUnleashedProbeDiagnostic,
	type AccessNetworksUnleashedSubnetProbeSummary,
} from './types.ts'

function normalizeHostUrl(value: string) {
	const url = new URL(value)
	url.pathname = ''
	url.search = ''
	url.hash = ''
	return url.toString().replace(/\/$/, '')
}

function sanitizeControllerName(
	value: string | null,
	host: string,
	index: number,
) {
	const trimmed = value?.trim()
	if (trimmed) return trimmed
	return `Unleashed controller ${host || String(index + 1)}`
}

function expandScanCidr(cidr: string): Array<string> {
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
			`Invalid Access Networks Unleashed scan CIDR "${cidr}". Use a.b.c.0/24 or a.b.c.d/32.`,
		)
	}
	const a = Number(slash24[1])
	const b = Number(slash24[2])
	const c = Number(slash24[3])
	if ([a, b, c].some((octet) => octet < 0 || octet > 255)) {
		throw new Error(`Invalid Access Networks Unleashed scan CIDR "${cidr}".`)
	}

	const ips: Array<string> = []
	for (let host = 1; host <= 254; host++) {
		ips.push(`${a}.${b}.${c}.${host}`)
	}
	return ips
}

function tryExpandScanCidr(cidr: string): Array<string> {
	try {
		return expandScanCidr(cidr)
	} catch (error) {
		console.warn(
			`Skipping Access Networks Unleashed scan CIDR "${cidr}": ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}

function createDispatcher(config: HomeConnectorConfig) {
	if (!config.accessNetworksUnleashedAllowInsecureTls) return undefined
	return new Agent({
		connect: {
			rejectUnauthorized: false,
		},
	})
}

async function fetchWithTimeout(input: {
	url: string
	timeoutMs: number
	dispatcher?: Agent
}) {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
	try {
		return await fetch(input.url, {
			method: 'GET',
			redirect: 'manual',
			signal: controller.signal,
			...(input.dispatcher ? { dispatcher: input.dispatcher } : {}),
		} as RequestInit)
	} finally {
		clearTimeout(timeout)
	}
}

function buildProbeUrls(host: string) {
	const baseUrl = `https://${host}`
	return [`${baseUrl}/`, `${baseUrl}/admin/`, `${baseUrl}/admin/login.jsp`]
}

function matchControllerResponse(input: {
	host: string
	url: string
	status: number
	location: string | null
	body: string
	index: number
}): {
	controller: AccessNetworksUnleashedDiscoveredController | null
	diagnostic: AccessNetworksUnleashedProbeDiagnostic
} {
	const location = input.location
	const body = input.body
	const matchedByRedirect =
		Boolean(location) &&
		/admin\/(?:wsg\/)?login\.jsp/i.test(location ?? '') &&
		(input.status === 301 || input.status === 302 || input.status === 303)
	const matchedByBody =
		/unleashed/i.test(body) &&
		/(ruckus|access networks|x-csrf-token|login)/i.test(body)
	const diagnostic: AccessNetworksUnleashedProbeDiagnostic = {
		host: input.host,
		url: input.url,
		matched: matchedByRedirect || matchedByBody,
		status: input.status,
		location,
		matchReason: matchedByRedirect
			? 'redirect'
			: matchedByBody
				? 'login-page'
				: null,
		error: null,
		bodySnippet: body.slice(0, 240) || null,
	}
	if (!diagnostic.matched) {
		return { controller: null, diagnostic }
	}

	const inferredLoginUrl =
		location && /admin\/(?:wsg\/)?login\.jsp/i.test(location)
			? new URL(location, input.url).toString()
			: `${normalizeHostUrl(input.url)}/admin/wsg/login.jsp`
	const titleMatch =
		/<title>\s*([^<]+)\s*<\/title>/i.exec(body) ??
		/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i.exec(body)
	const name = sanitizeControllerName(
		titleMatch?.[1] ?? null,
		input.host,
		input.index,
	)
	return {
		controller: {
			controllerId: input.host,
			name,
			host: input.host,
			loginUrl: inferredLoginUrl,
			lastSeenAt: new Date().toISOString(),
			rawDiscovery: {
				status: input.status,
				location,
				probeUrl: input.url,
				bodySnippet: diagnostic.bodySnippet,
			},
		},
		diagnostic,
	}
}

async function probeHost(input: {
	host: string
	index: number
	config: HomeConnectorConfig
	dispatcher?: Agent
}): Promise<{
	controller: AccessNetworksUnleashedDiscoveredController | null
	diagnostic: AccessNetworksUnleashedProbeDiagnostic
}> {
	let lastDiagnostic: AccessNetworksUnleashedProbeDiagnostic | null = null
	for (const url of buildProbeUrls(input.host)) {
		try {
			const response = await fetchWithTimeout({
				url,
				timeoutMs: Math.min(
					input.config.accessNetworksUnleashedRequestTimeoutMs,
					2_500,
				),
				dispatcher: input.dispatcher,
			})
			const body = await response.text().catch(() => '')
			const match = matchControllerResponse({
				host: input.host,
				url,
				status: response.status,
				location: response.headers.get('location'),
				body,
				index: input.index,
			})
			if (match.controller) return match
			lastDiagnostic = match.diagnostic
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				return {
					controller: null,
					diagnostic: {
						host: input.host,
						url,
						matched: false,
						status: null,
						location: null,
						matchReason: null,
						error: `Request timed out for ${url}`,
						bodySnippet: null,
					},
				}
			}
			return {
				controller: null,
				diagnostic: {
					host: input.host,
					url,
					matched: false,
					status: null,
					location: null,
					matchReason: null,
					error: error instanceof Error ? error.message : String(error),
					bodySnippet: null,
				},
			}
		}
	}

	return {
		controller: null,
		diagnostic: lastDiagnostic ?? {
			host: input.host,
			url: `https://${input.host}/`,
			matched: false,
			status: null,
			location: null,
			matchReason: null,
			error: null,
			bodySnippet: null,
		},
	}
}

async function discoverControllers(
	config: HomeConnectorConfig,
): Promise<AccessNetworksUnleashedDiscoveryResult> {
	const targets: Array<string> = []
	for (const cidr of config.accessNetworksUnleashedScanCidrs) {
		targets.push(...tryExpandScanCidr(cidr))
	}
	const dispatcher = createDispatcher(config)
	const concurrency = Math.max(1, Math.min(targets.length, 64))
	const diagnostics: Array<AccessNetworksUnleashedProbeDiagnostic> = []
	const controllers = new Map<
		string,
		AccessNetworksUnleashedDiscoveredController
	>()
	let cursor = 0

	async function worker() {
		for (;;) {
			const index = cursor++
			if (index >= targets.length) return
			const host = targets[index]
			if (!host) continue
			const result = await probeHost({
				host,
				index,
				config,
				...(dispatcher ? { dispatcher } : {}),
			})
			diagnostics.push(result.diagnostic)
			if (result.controller) {
				controllers.set(result.controller.controllerId, result.controller)
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()))
	if (dispatcher) {
		await dispatcher.close()
	}
	const summary: AccessNetworksUnleashedSubnetProbeSummary = {
		cidrs: config.accessNetworksUnleashedScanCidrs,
		hostsProbed: targets.length,
		controllerMatches: controllers.size,
	}
	const outputDiagnostics: AccessNetworksUnleashedDiscoveryDiagnostics = {
		protocol: 'subnet',
		discoveryUrl:
			config.accessNetworksUnleashedScanCidrs.length > 0
				? config.accessNetworksUnleashedScanCidrs.join(', ')
				: 'no-scan-cidrs',
		scannedAt: new Date().toISOString(),
		probes: diagnostics,
		subnetProbe: summary,
	}
	return {
		controllers: [...controllers.values()],
		diagnostics: outputDiagnostics,
	}
}

export async function scanAccessNetworksUnleashedControllers(
	state: HomeConnectorState,
	config: HomeConnectorConfig,
) {
	const result = await discoverControllers(config)
	setAccessNetworksUnleashedDiscoveryDiagnostics(state, result.diagnostics)
	return result
}
