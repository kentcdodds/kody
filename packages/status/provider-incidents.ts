/**
 * Cloudflare Statuspage feed for products kody actually runs on.
 *
 * This is corroborating context only — Cloudflare's public status page lags
 * reality and must never gate or suppress kody's own probe-based alerts.
 * Fetch failures are fail-soft: callers get an empty list and keep serving.
 */

export const cloudflareStatusIncidentsUrl =
	'https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json'

export const cloudflareStatusPageUrl = 'https://www.cloudflarestatus.com'

/** Exact Statuspage component names for products kody depends on. */
export const relevantCloudflareComponentNames = [
	'Workers',
	'D1',
	'R2',
	'Workers KV',
	'Durable Objects',
	'Queues',
	'Vectorize',
	'Email Routing',
	'Access',
] as const

const relevantNameSet = new Set<string>(relevantCloudflareComponentNames)

export const providerIncidentFetchTimeoutMs = 2500
export const providerIncidentCacheTtlMs = 60_000
/** Keep a slightly stale cache across one missed cron tick / flaky API. */
export const providerIncidentCacheStaleMs = 5 * 60_000

export type ProviderIncidentStatus =
	| 'investigating'
	| 'identified'
	| 'monitoring'
	| 'postmortem'
	| 'resolved'
	| 'scheduled'
	| 'in_progress'
	| 'verifying'
	| 'completed'
	| string

export type ProviderIncident = {
	id: string
	name: string
	status: ProviderIncidentStatus
	impact: string
	shortlink: string
	updatedAt: string
	affectedComponents: Array<string>
}

type StatuspageComponent = {
	id?: string
	name?: string
}

type StatuspageIncident = {
	id?: string
	name?: string
	status?: string
	impact?: string
	shortlink?: string
	updated_at?: string
	components?: Array<StatuspageComponent>
	incident_updates?: Array<{
		affected_components?: Array<{ code?: string; name?: string }>
	}>
}

type StatuspageIncidentsResponse = {
	incidents?: Array<StatuspageIncident>
}

function componentNameFromStatuspageLabel(label: string): string {
	const separator = ' - '
	const index = label.lastIndexOf(separator)
	if (index === -1) return label.trim()
	return label.slice(index + separator.length).trim()
}

function collectAffectedComponentNames(
	incident: StatuspageIncident,
): Array<string> {
	const names = new Set<string>()
	for (const component of incident.components ?? []) {
		if (typeof component.name === 'string' && component.name.trim()) {
			names.add(component.name.trim())
		}
	}
	for (const update of incident.incident_updates ?? []) {
		for (const affected of update.affected_components ?? []) {
			if (typeof affected.name !== 'string' || !affected.name.trim()) continue
			names.add(componentNameFromStatuspageLabel(affected.name))
		}
	}
	return [...names]
}

export function isRelevantCloudflareComponentName(name: string): boolean {
	return relevantNameSet.has(name)
}

export function filterRelevantProviderIncidents(
	incidents: Array<StatuspageIncident>,
): Array<ProviderIncident> {
	const filtered: Array<ProviderIncident> = []
	for (const incident of incidents) {
		if (typeof incident.id !== 'string' || !incident.id) continue
		if (typeof incident.name !== 'string' || !incident.name.trim()) continue
		const affectedComponents = collectAffectedComponentNames(incident)
		const relevantAffected = affectedComponents.filter(
			isRelevantCloudflareComponentName,
		)
		if (relevantAffected.length === 0) continue
		filtered.push({
			id: incident.id,
			name: incident.name.trim(),
			status: incident.status?.trim() || 'unknown',
			impact: incident.impact?.trim() || 'unknown',
			shortlink:
				typeof incident.shortlink === 'string' && incident.shortlink.trim()
					? incident.shortlink.trim()
					: cloudflareStatusPageUrl,
			updatedAt:
				typeof incident.updated_at === 'string' && incident.updated_at
					? incident.updated_at
					: new Date(0).toISOString(),
			affectedComponents: relevantAffected,
		})
	}
	return filtered
}

export function parseProviderIncidentsPayload(
	payload: unknown,
): Array<ProviderIncident> {
	if (payload === null || typeof payload !== 'object') return []
	const incidents = (payload as StatuspageIncidentsResponse).incidents
	if (!Array.isArray(incidents)) return []
	return filterRelevantProviderIncidents(incidents)
}

export type ProviderIncidentCache = {
	fetchedAt: number
	incidents: Array<ProviderIncident>
}

export function serializeProviderIncidentCache(
	cache: ProviderIncidentCache,
): string {
	return JSON.stringify(cache)
}

export function parseProviderIncidentCache(
	raw: string | null,
	now: number,
	options: { maxAgeMs?: number } = {},
): Array<ProviderIncident> | null {
	if (raw === null) return null
	const maxAgeMs = options.maxAgeMs ?? providerIncidentCacheStaleMs
	let parsed: unknown
	try {
		parsed = JSON.parse(raw) as unknown
	} catch {
		return null
	}
	if (parsed === null || typeof parsed !== 'object') return null
	const cache = parsed as Partial<ProviderIncidentCache>
	if (
		typeof cache.fetchedAt !== 'number' ||
		!Number.isFinite(cache.fetchedAt)
	) {
		return null
	}
	if (now - cache.fetchedAt > maxAgeMs) return null
	if (!Array.isArray(cache.incidents)) return null
	return cache.incidents.filter(isProviderIncident)
}

function isProviderIncident(value: unknown): value is ProviderIncident {
	if (value === null || typeof value !== 'object') return false
	const incident = value as Partial<ProviderIncident>
	return (
		typeof incident.id === 'string' &&
		typeof incident.name === 'string' &&
		typeof incident.status === 'string' &&
		typeof incident.impact === 'string' &&
		typeof incident.shortlink === 'string' &&
		typeof incident.updatedAt === 'string' &&
		Array.isArray(incident.affectedComponents) &&
		incident.affectedComponents.every(
			(component) => typeof component === 'string',
		)
	)
}

export type FetchProviderIncidentsOptions = {
	fetcher?: typeof fetch
	timeoutMs?: number
	url?: string
}

export type FetchProviderIncidentsResult =
	| { ok: true; incidents: Array<ProviderIncident> }
	| { ok: false; incidents: Array<ProviderIncident>; error: string }

/**
 * Fetches unresolved Cloudflare incidents and filters to kody-relevant
 * products. Never throws: network / timeout / parse failures return
 * `{ ok: false }` so callers can keep a still-fresh cache.
 */
export async function fetchRelevantProviderIncidents(
	options: FetchProviderIncidentsOptions = {},
): Promise<FetchProviderIncidentsResult> {
	const fetcher = options.fetcher ?? fetch
	const timeoutMs = options.timeoutMs ?? providerIncidentFetchTimeoutMs
	const url = options.url ?? cloudflareStatusIncidentsUrl
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(
				new Error(`provider incidents fetch timed out after ${timeoutMs}ms`),
			)
		}, timeoutMs)
	})
	try {
		const response = await Promise.race([
			fetcher(url, {
				method: 'GET',
				headers: { Accept: 'application/json' },
				signal: controller.signal,
			}),
			timeout,
		])
		if (!response.ok) {
			const error = `HTTP ${response.status}`
			console.warn(
				'status-provider-incidents-http',
				JSON.stringify({ status: response.status }),
			)
			return { ok: false, incidents: [], error }
		}
		const payload: unknown = await Promise.race([
			response.json().catch(() => null),
			timeout,
		])
		if (payload === null) {
			const error = 'invalid JSON'
			console.warn('status-provider-incidents-fetch-failed', error)
			return { ok: false, incidents: [], error }
		}
		return { ok: true, incidents: parseProviderIncidentsPayload(payload) }
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.warn('status-provider-incidents-fetch-failed', detail)
		return { ok: false, incidents: [], error: detail }
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

export function formatProviderIncidentAnnotation(
	incidents: Array<ProviderIncident>,
): string | null {
	if (incidents.length === 0) return null
	return incidents
		.map(
			(incident) =>
				`Possibly related Cloudflare incident: ${incident.name} (${incident.status})`,
		)
		.join('\n')
}
