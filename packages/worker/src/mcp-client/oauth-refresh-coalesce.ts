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
 * `saveTokens` writes are idempotent.
 */

type BufferedRefreshResponse = {
	status: number
	statusText: string
	headers: Headers
	body: ArrayBuffer
}

const refreshFlights = new WeakMap<
	object,
	Map<string, Promise<BufferedRefreshResponse>>
>()

export function isMcpOAuthRefreshTokenGrantBody(body: unknown): boolean {
	if (typeof body !== 'string') return false
	try {
		return new URLSearchParams(body).get('grant_type') === 'refresh_token'
	} catch {
		return false
	}
}

export function readRefreshTokenFromTokenRequestBody(
	body: unknown,
): string | null {
	if (typeof body !== 'string') return null
	try {
		const value = new URLSearchParams(body).get('refresh_token')
		return value && value.trim().length > 0 ? value : null
	} catch {
		return null
	}
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

		let flights = refreshFlights.get(scope)
		if (!flights) {
			flights = new Map()
			refreshFlights.set(scope, flights)
		}

		const existing = flights.get(refreshToken)
		if (existing) {
			return responseFromBuffered(await existing)
		}

		const flight = (async (): Promise<BufferedRefreshResponse> => {
			const response = await baseFetch(input, init)
			return {
				status: response.status,
				statusText: response.statusText,
				headers: new Headers(response.headers),
				body: await response.arrayBuffer(),
			}
		})().finally(() => {
			const current = refreshFlights.get(scope)
			if (current?.get(refreshToken) === flight) {
				current.delete(refreshToken)
				if (current.size === 0) {
					refreshFlights.delete(scope)
				}
			}
		})

		flights.set(refreshToken, flight)
		return responseFromBuffered(await flight)
	}
}

function responseFromBuffered(buffered: BufferedRefreshResponse) {
	return new Response(buffered.body.slice(0), {
		status: buffered.status,
		statusText: buffered.statusText,
		headers: new Headers(buffered.headers),
	})
}
