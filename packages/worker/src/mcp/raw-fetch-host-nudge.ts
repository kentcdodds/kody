import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'

/** Cumulative raw-fetch count that tips a one-line host nudge. */
export const rawFetchHostNudgeThreshold = 3

/** Cap tracked hostnames per conversation (FIFO eviction). */
export const maxRawFetchHostsPerConversation = 20

/** Cap tracked conversations in MCP agent DO state (FIFO eviction). */
export const maxRawFetchHostConversations = 50

export type RawFetchHostEntry = {
	count: number
	nudged: boolean
}

export type RawFetchHostConversationState = {
	hostOrder: Array<string>
	hosts: Record<string, RawFetchHostEntry>
}

export type RawFetchHostNudgeState = {
	conversationOrder: Array<string>
	byConversation: Record<string, RawFetchHostConversationState>
}

export type RawFetchHostSink = {
	add: (hostname: string) => void
}

/**
 * Read a hostname from a request URL string without ever consulting a
 * secret-expanded URL. Placeholders contain `:`, which cannot appear in a
 * parsed hostname, so a successfully parsed hostname is always literal.
 */
export function readLiteralRequestHostname(url: string) {
	try {
		return new URL(url).hostname
	} catch {
		return ''
	}
}

export function createRawFetchHostSink() {
	const counts = new Map<string, number>()
	const sink: RawFetchHostSink = {
		add(hostname) {
			const normalized = normalizeHost(hostname)
			if (!normalized) return
			counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
		},
	}
	return {
		sink,
		snapshot(): Record<string, number> {
			return Object.fromEntries(counts.entries())
		},
		hostCounts(): ReadonlyMap<string, number> {
			return counts
		},
	}
}

export function readHostnameFromFetchInput(input: RequestInfo | URL) {
	if (typeof input === 'string') {
		return readLiteralRequestHostname(input)
	}
	if (input instanceof URL) {
		return readLiteralRequestHostname(input.toString())
	}
	return readLiteralRequestHostname(input.url)
}

/**
 * Test/helper wrapper that records literal hostnames from fetch inputs.
 * Do not pass the result to WorkerLoader `globalOutbound` — LOADER requires a
 * real Fetcher binding. Production counting wraps `globalThis.fetch` inside
 * the execute sandbox instead (see `#mcp/executor.ts`).
 */
export function wrapOutboundFetcherRecordingHosts(
	outbound: Fetcher,
	sink: RawFetchHostSink,
	options: { excludedHostname?: string | null } = {},
): Fetcher {
	const excluded = options.excludedHostname
		? normalizeHost(options.excludedHostname)
		: ''
	return {
		fetch(input: RequestInfo | URL, init?: RequestInit) {
			const hostname = normalizeHost(readHostnameFromFetchInput(input))
			if (hostname && hostname !== excluded) {
				sink.add(hostname)
			}
			return outbound.fetch(input, init)
		},
	} as Fetcher
}

/**
 * True when execute/package source references raw OAuth/integration auth
 * helpers. Used only to sharpen the packages-first failure-moment steer —
 * not as a hard gate (smoke tests still use these helpers).
 */
export function codeUsesIntegrationAuthHelpers(code: string) {
	return /\b(?:createAuthenticatedFetch|refreshAccessToken)\b/.test(code)
}

/**
 * One-line packages-first steer when ad hoc execute repeatedly raw-fetches a
 * product API host. Integrations are auth; packages are how agents should call
 * the product. Prefer trusted community packages when forking.
 */
export function formatRawFetchHostNudge(input: {
	hostname: string
	count: number
	usedIntegrationAuthHelpers?: boolean
}) {
	const mentalModel =
		'Integrations = auth; packages = how agents should call the product.'
	const packagesFirst =
		'Prefer a package: search for an existing wrapper, then community_search (prefer trusted), then fork or create a thin helpers package.'
	const openapiAside =
		'Use openapi_binding_save only when an OpenAPI binding fits.'
	if (input.usedIntegrationAuthHelpers) {
		return `Raw integration auth hit ${input.hostname} ${input.count}x this conversation. ${mentalModel} ${packagesFirst} ${openapiAside}`
	}
	return `Raw-fetched ${input.hostname} ${input.count}x this conversation. ${mentalModel} ${packagesFirst} ${openapiAside}`
}

/**
 * Hosts that would tip the nudge threshold after applying `hostCounts`, and
 * have not already been nudged. Used to decide whether a binding-host lookup
 * is worth doing on the execute hot path.
 */
export function listHostsApproachingRawFetchNudge(input: {
	state: RawFetchHostNudgeState | null | undefined
	conversationId: string
	hostCounts: ReadonlyMap<string, number> | Record<string, number>
}): Array<string> {
	const conversationId = input.conversationId.trim()
	if (!conversationId) return []
	const state = normalizeRawFetchHostNudgeState(input.state)
	const conversation = state.byConversation[conversationId]
	const approaching: Array<string> = []
	for (const [hostname, increment] of toHostCountEntries(input.hostCounts)) {
		if (increment <= 0) continue
		const existing = conversation?.hosts[hostname]
		if (existing?.nudged) continue
		const nextCount = (existing?.count ?? 0) + increment
		if (nextCount >= rawFetchHostNudgeThreshold) {
			approaching.push(hostname)
		}
	}
	return approaching
}

export function applyRawFetchHostCounts(input: {
	state: RawFetchHostNudgeState | null | undefined
	conversationId: string
	hostCounts: ReadonlyMap<string, number> | Record<string, number>
	/** Hosts that already have a saved OpenAPI binding — never nudge these. */
	coveredHosts?: ReadonlySet<string> | Iterable<string>
	/**
	 * When the execute module used createAuthenticatedFetch / refreshAccessToken,
	 * sharpen the nudge toward packages (integrations are auth only).
	 */
	usedIntegrationAuthHelpers?: boolean
}): {
	state: RawFetchHostNudgeState
	nudges: Array<string>
} {
	const conversationId = input.conversationId.trim()
	if (!conversationId) {
		return {
			state: normalizeRawFetchHostNudgeState(input.state),
			nudges: [],
		}
	}

	const next = cloneRawFetchHostNudgeState(input.state)
	const conversation = ensureConversationState(next, conversationId)
	const covered = toNormalizedHostSet(input.coveredHosts)
	const increments = toHostCountEntries(input.hostCounts)
	const nudges: Array<string> = []
	const usedIntegrationAuthHelpers = input.usedIntegrationAuthHelpers === true

	for (const [hostname, increment] of increments) {
		if (increment <= 0) continue
		const entry = ensureHostEntry(conversation, hostname)
		entry.count += increment
		touchHostOrder(conversation, hostname)

		if (
			entry.count >= rawFetchHostNudgeThreshold &&
			!entry.nudged &&
			!covered.has(hostname)
		) {
			entry.nudged = true
			nudges.push(
				formatRawFetchHostNudge({
					hostname,
					count: entry.count,
					usedIntegrationAuthHelpers,
				}),
			)
		}
	}

	trimConversationHosts(conversation)
	trimConversations(next)
	return { state: next, nudges }
}

export function normalizeRawFetchHostNudgeState(
	state: RawFetchHostNudgeState | null | undefined,
): RawFetchHostNudgeState {
	return cloneRawFetchHostNudgeState(state)
}

export function readBaseUrlHostname(baseUrl: string) {
	return normalizeHost(readLiteralRequestHostname(baseUrl.trim()))
}

function cloneRawFetchHostNudgeState(
	state: RawFetchHostNudgeState | null | undefined,
): RawFetchHostNudgeState {
	const conversationOrder = Array.isArray(state?.conversationOrder)
		? state.conversationOrder.filter(
				(value): value is string =>
					typeof value === 'string' && value.trim() !== '',
			)
		: []
	const byConversation: Record<string, RawFetchHostConversationState> = {}
	const source = state?.byConversation
	if (source && typeof source === 'object') {
		for (const conversationId of conversationOrder) {
			const entry = source[conversationId]
			if (!entry || typeof entry !== 'object') continue
			const hostOrder = Array.isArray(entry.hostOrder)
				? entry.hostOrder.filter(
						(value): value is string =>
							typeof value === 'string' && normalizeHost(value) !== '',
					)
				: []
			const hosts: Record<string, RawFetchHostEntry> = {}
			for (const hostname of hostOrder) {
				const normalized = normalizeHost(hostname)
				const hostEntry = entry.hosts?.[normalized] ?? entry.hosts?.[hostname]
				const count =
					typeof hostEntry?.count === 'number' &&
					Number.isFinite(hostEntry.count) &&
					hostEntry.count > 0
						? Math.floor(hostEntry.count)
						: 0
				if (count <= 0) continue
				hosts[normalized] = {
					count,
					nudged: hostEntry?.nudged === true,
				}
			}
			byConversation[conversationId] = {
				hostOrder: hostOrder
					.map((hostname) => normalizeHost(hostname))
					.filter((hostname, index, all) => {
						return hostname !== '' && all.indexOf(hostname) === index
					})
					.filter((hostname) => hosts[hostname] != null),
				hosts,
			}
		}
	}
	return { conversationOrder, byConversation }
}

function ensureConversationState(
	state: RawFetchHostNudgeState,
	conversationId: string,
): RawFetchHostConversationState {
	const existing = state.byConversation[conversationId]
	if (existing) {
		touchConversationOrder(state, conversationId)
		return existing
	}
	const created: RawFetchHostConversationState = {
		hostOrder: [],
		hosts: {},
	}
	state.byConversation[conversationId] = created
	touchConversationOrder(state, conversationId)
	return created
}

function ensureHostEntry(
	conversation: RawFetchHostConversationState,
	hostname: string,
): RawFetchHostEntry {
	const existing = conversation.hosts[hostname]
	if (existing) return existing
	const created: RawFetchHostEntry = { count: 0, nudged: false }
	conversation.hosts[hostname] = created
	return created
}

function touchConversationOrder(
	state: RawFetchHostNudgeState,
	conversationId: string,
) {
	state.conversationOrder = [
		...state.conversationOrder.filter((id) => id !== conversationId),
		conversationId,
	]
}

function touchHostOrder(
	conversation: RawFetchHostConversationState,
	hostname: string,
) {
	conversation.hostOrder = [
		...conversation.hostOrder.filter((entry) => entry !== hostname),
		hostname,
	]
}

function trimConversationHosts(conversation: RawFetchHostConversationState) {
	while (conversation.hostOrder.length > maxRawFetchHostsPerConversation) {
		const evicted = conversation.hostOrder.shift()
		if (!evicted) break
		delete conversation.hosts[evicted]
	}
}

function trimConversations(state: RawFetchHostNudgeState) {
	while (state.conversationOrder.length > maxRawFetchHostConversations) {
		const evicted = state.conversationOrder.shift()
		if (!evicted) break
		delete state.byConversation[evicted]
	}
}

function toHostCountEntries(
	hostCounts: ReadonlyMap<string, number> | Record<string, number>,
) {
	const entries =
		hostCounts instanceof Map
			? Array.from(hostCounts.entries())
			: Object.entries(hostCounts)
	return entries
		.map(([hostname, count]) => [normalizeHost(hostname), count] as const)
		.filter(([hostname, count]) => hostname !== '' && count > 0)
}

function toNormalizedHostSet(
	hosts: ReadonlySet<string> | Iterable<string> | undefined,
) {
	const set = new Set<string>()
	if (!hosts) return set
	for (const host of hosts) {
		const normalized = normalizeHost(host)
		if (normalized) set.add(normalized)
	}
	return set
}
