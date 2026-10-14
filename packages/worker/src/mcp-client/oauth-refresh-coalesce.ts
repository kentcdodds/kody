/**
 * Coalesce concurrent refresh_token POSTs that present the same refresh
 * token. Rotating authorization servers revoke the whole family when a
 * consumed refresh token is reused (RFC 6819 §5.2.2.3). The MCP client calls
 * `auth()` on every 401 with no single-flight, so two in-flight tool calls
 * can POST the same parent refresh token; the loser triggers family
 * revocation and Kody wipes the grant that just succeeded.
 *
 * One HTTP exchange per refresh_token value; concurrent callers share the
 * buffered response (including the rotated refresh token) so both
 * `saveTokens` writes are idempotent. A successful exchange stays shared
 * until {@link releaseMcpOAuthRefreshCoalesce} runs after `saveTokens` (or a
 * grace timeout), so a second 401 before persistence still reuses the first
 * response instead of spending the parent token again.
 */

type BufferedRefreshResponse = {
	status: number
	statusText: string
	headers: Headers
	body: ArrayBuffer
}

type RefreshFlightMaps = {
	inFlight: Map<string, Promise<BufferedRefreshResponse>>
	completed: Map<
		string,
		{ buffered: BufferedRefreshResponse; expiresAt: number }
	>
}

const refreshFlights = new WeakMap<object, RefreshFlightMaps>()

/** How long a successful refresh response stays shareable after the HTTP round-trip. */
export const mcpOAuthRefreshCoalesceGraceMs = 30_000

function tokenRequestParamsFromBody(body: unknown): URLSearchParams | null {
	if (typeof body === 'string') {
		try {
			return new URLSearchParams(body)
		} catch {
			return null
		}
	}
	if (body instanceof URLSearchParams) {
		return new URLSearchParams(body)
	}
	if (typeof FormData !== 'undefined' && body instanceof FormData) {
		const params = new URLSearchParams()
		for (const [key, value] of body.entries()) {
			if (typeof value === 'string') params.append(key, value)
		}
		return params
	}
	return null
}

export function isMcpOAuthRefreshTokenGrantBody(body: unknown): boolean {
	const params = tokenRequestParamsFromBody(body)
	return params?.get('grant_type') === 'refresh_token'
}

export function readRefreshTokenFromTokenRequestBody(
	body: unknown,
): string | null {
	const params = tokenRequestParamsFromBody(body)
	const value = params?.get('refresh_token')
	return value && value.trim().length > 0 ? value : null
}

function mapsFor(scope: object): RefreshFlightMaps {
	let maps = refreshFlights.get(scope)
	if (!maps) {
		maps = { inFlight: new Map(), completed: new Map() }
		refreshFlights.set(scope, maps)
	}
	return maps
}

function pruneCompleted(maps: RefreshFlightMaps, now = Date.now()) {
	for (const [key, entry] of maps.completed) {
		if (entry.expiresAt <= now) maps.completed.delete(key)
	}
}

/**
 * Drop coalesced refresh state after tokens are persisted (or invalidated).
 * Call from `saveTokens` / `invalidateCredentials` so the next refresh can
 * use the rotated token.
 */
export function releaseMcpOAuthRefreshCoalesce(scope: object) {
	refreshFlights.delete(scope)
}

/**
 * Wrap `fetch` so refresh_token grants for `scope` (typically the OAuth
 * provider instance) share one in-flight POST per refresh_token value.
 */
export function wrapFetchForMcpOAuthRefreshCoalesce(
	scope: object,
	baseFetch: typeof fetch = fetch,
): typeof fetch {
	return async (input, init) => {
		const body = init?.body
		if (!isMcpOAuthRefreshTokenGrantBody(body)) {
			return baseFetch(input, init)
		}
		const refreshToken = readRefreshTokenFromTokenRequestBody(body)
		if (!refreshToken) {
			return baseFetch(input, init)
		}

		const maps = mapsFor(scope)
		pruneCompleted(maps)

		const existing = maps.inFlight.get(refreshToken)
		if (existing) {
			return responseFromBuffered(await existing)
		}
		const completed = maps.completed.get(refreshToken)
		if (completed) {
			return responseFromBuffered(completed.buffered)
		}

		const flight = (async (): Promise<BufferedRefreshResponse> => {
			const response = await baseFetch(input, init)
			return {
				status: response.status,
				statusText: response.statusText,
				headers: new Headers(response.headers),
				body: await response.arrayBuffer(),
			}
		})()

		maps.inFlight.set(refreshToken, flight)
		try {
			const buffered = await flight
			maps.completed.set(refreshToken, {
				buffered,
				expiresAt: Date.now() + mcpOAuthRefreshCoalesceGraceMs,
			})
			return responseFromBuffered(buffered)
		} finally {
			if (maps.inFlight.get(refreshToken) === flight) {
				maps.inFlight.delete(refreshToken)
			}
		}
	}
}

function responseFromBuffered(buffered: BufferedRefreshResponse) {
	return new Response(buffered.body.slice(0), {
		status: buffered.status,
		statusText: buffered.statusText,
		headers: new Headers(buffered.headers),
	})
}
