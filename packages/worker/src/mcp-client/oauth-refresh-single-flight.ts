/**
 * One in-flight refresh per presented refresh token.
 *
 * The MCP SDK calls `auth()` on every 401, and each call redeems
 * `refresh_token` immediately. Overlapping tool calls, or a streamable
 * HTTP GET plus POST, can both present the same token. An authorization
 * server that rotates and revokes the family on reuse (MediRSS does;
 * the home MCP server does not) then invalidates the winner. The SDK
 * treats that `invalid_grant` as "delete the stored tokens," which is
 * the "no refresh token" card.
 *
 * Followers share the leader's token-endpoint response, so the server
 * sees one redemption. `invalidateCredentials('tokens')` keeps a stored
 * refresh token when this isolate already rotated it and the issued
 * token has not itself been rejected.
 */

const mcpOAuthRefreshReplayTtlMs = 2 * 60 * 1000
const mcpOAuthRefreshReplayLimit = 32

type RefreshSuccess = {
	presentedRefreshToken: string
	issuedRefreshToken: string | null
	at: number
	status: number
	statusText: string
	headers: Array<[string, string]>
	body: string
}

type RefreshFlightState = {
	inflight: Map<string, Promise<RefreshSuccess>>
	succeeded: Map<string, RefreshSuccess>
	failures: Map<string, number>
}

const sharedState: RefreshFlightState = createMcpOAuthRefreshFlightState()

export function createMcpOAuthRefreshFlightState(): RefreshFlightState {
	return {
		inflight: new Map(),
		succeeded: new Map(),
		failures: new Map(),
	}
}

let installed = false

export function installMcpOAuthRefreshSingleFlight() {
	if (installed) return
	installed = true
	const base = globalThis.fetch.bind(globalThis)
	globalThis.fetch = createMcpOAuthRefreshSingleFlightFetch(base)
}

export function clearMcpOAuthRefreshSingleFlightForTests() {
	sharedState.inflight.clear()
	sharedState.succeeded.clear()
	sharedState.failures.clear()
}

export function createMcpOAuthRefreshSingleFlightFetch(
	base: typeof fetch,
	options?: {
		now?: () => number
		ttlMs?: number
		state?: RefreshFlightState
	},
): typeof fetch {
	const state = options?.state ?? sharedState
	const now = options?.now ?? Date.now
	const ttlMs = options?.ttlMs ?? mcpOAuthRefreshReplayTtlMs
	return async (input, init) => {
		const grant = readRefreshGrant(input, init)
		if (!grant) return base(input, init)
		const key = flightKey(grant)
		const cached = freshSuccess(state, key, now(), ttlMs)
		if (cached) return responseFrom(cached)
		let flight = state.inflight.get(key)
		if (!flight) {
			flight = exchangeRefresh(base, input, init, grant, key, state, now)
			state.inflight.set(key, flight)
		}
		try {
			return responseFrom(await flight)
		} finally {
			if (state.inflight.get(key) === flight) state.inflight.delete(key)
		}
	}
}

export function shouldPreserveMcpOAuthRefreshToken(
	storedRefreshToken: string | null,
	now = Date.now(),
) {
	return refreshTokenSurvivedRotation({
		storedRefreshToken,
		successes: [...sharedState.succeeded.values()],
		failures: [...sharedState.failures.entries()].map(([refreshToken, at]) => ({
			refreshToken,
			at,
		})),
		now,
		ttlMs: mcpOAuthRefreshReplayTtlMs,
	})
}

export function refreshTokenSurvivedRotation(input: {
	storedRefreshToken: string | null
	successes: ReadonlyArray<{
		presentedRefreshToken: string
		issuedRefreshToken: string | null
		at: number
	}>
	failures: ReadonlyArray<{ refreshToken: string; at: number }>
	now: number
	ttlMs: number
}) {
	const stored = input.storedRefreshToken
	if (!stored) return false
	const failureAt = new Map(
		input.failures.map((failure) => [failure.refreshToken, failure.at]),
	)
	for (const success of input.successes) {
		if (input.now - success.at > input.ttlMs) continue
		const issued = success.issuedRefreshToken
		if (!issued) continue
		const rotatedAway =
			success.presentedRefreshToken === stored && issued !== stored
		const storedIsIssued =
			issued === stored && success.presentedRefreshToken !== stored
		if (!rotatedAway && !storedIsIssued) continue
		const issuedFailure = failureAt.get(issued)
		if (issuedFailure !== undefined && issuedFailure >= success.at) continue
		return true
	}
	return false
}

async function exchangeRefresh(
	base: typeof fetch,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	grant: RefreshGrant,
	key: string,
	state: RefreshFlightState,
	now: () => number,
): Promise<RefreshSuccess> {
	const response = await base(input, init)
	const body = await response.text()
	const record: RefreshSuccess = {
		presentedRefreshToken: grant.refreshToken,
		issuedRefreshToken: readIssuedRefreshToken(body),
		at: now(),
		status: response.status,
		statusText: response.statusText,
		headers: [...response.headers.entries()],
		body,
	}
	if (response.ok) {
		state.succeeded.set(key, record)
		evictSuccesses(state)
	} else {
		state.failures.set(grant.refreshToken, record.at)
	}
	return record
}

function freshSuccess(
	state: RefreshFlightState,
	key: string,
	now: number,
	ttlMs: number,
) {
	const cached = state.succeeded.get(key)
	if (!cached) return null
	if (now - cached.at > ttlMs) {
		state.succeeded.delete(key)
		return null
	}
	return cached
}

function evictSuccesses(state: RefreshFlightState) {
	if (state.succeeded.size <= mcpOAuthRefreshReplayLimit) return
	const oldest = [...state.succeeded.entries()].sort(
		(left, right) => left[1].at - right[1].at,
	)
	while (
		state.succeeded.size > mcpOAuthRefreshReplayLimit &&
		oldest.length > 0
	) {
		const next = oldest.shift()
		if (next) state.succeeded.delete(next[0])
	}
}

function responseFrom(record: RefreshSuccess) {
	return new Response(record.body, {
		status: record.status,
		statusText: record.statusText,
		headers: record.headers,
	})
}

type RefreshGrant = {
	endpoint: string
	refreshToken: string
}

function flightKey(grant: RefreshGrant) {
	return `${grant.endpoint}\n${grant.refreshToken}`
}

function readRefreshGrant(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): RefreshGrant | null {
	const method = (
		init?.method ?? (input instanceof Request ? input.method : 'GET')
	).toUpperCase()
	if (method !== 'POST') return null
	const params = formParams(input, init)
	if (!params || params.get('grant_type') !== 'refresh_token') return null
	const refreshToken = params.get('refresh_token')?.trim() ?? ''
	if (!refreshToken) return null
	return {
		endpoint: endpointOf(input),
		refreshToken,
	}
}

function formParams(input: RequestInfo | URL, init: RequestInit | undefined) {
	const body = init?.body
	if (body instanceof URLSearchParams) return body
	if (typeof body !== 'string') return null
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	)
	const contentType = headers.get('content-type') ?? ''
	if (!contentType.includes('application/x-www-form-urlencoded')) return null
	return new URLSearchParams(body)
}

function endpointOf(input: RequestInfo | URL) {
	if (typeof input === 'string') return input
	if (input instanceof URL) return input.href
	return input.url
}

function readIssuedRefreshToken(body: string) {
	try {
		const parsed = JSON.parse(body) as { refresh_token?: unknown }
		const refreshToken = parsed.refresh_token
		if (typeof refreshToken !== 'string') return null
		const trimmed = refreshToken.trim()
		return trimmed.length > 0 ? trimmed : null
	} catch {
		return null
	}
}
