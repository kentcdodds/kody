/**
 * WebSocket upgrade helpers for package-app realtime.
 *
 * `@sentry/cloudflare` instruments Fetcher / Durable Object `fetch` and merges
 * `sentry-trace` into outbound headers. Plain-object `headers` inits keep every
 * header through that merge.
 *
 * workerd sends any `fetch` carrying `Upgrade: websocket` as a WebSocket
 * handshake and drops the request body, so upgrade forwards cannot carry data
 * in the body (see `packageRealtimeSessionRpc.connect`).
 */

export function isWebSocketUpgradeRequest(request: Request) {
	const upgrade = request.headers.get('Upgrade')
	return upgrade !== null && upgrade.toLowerCase() === 'websocket'
}

/**
 * Plain header map for a Fetcher/DO `fetch` that must remain a WebSocket upgrade
 * after Sentry (or any similar) outbound instrumentation.
 */
export function webSocketUpgradeFetchHeaders(
	headers?: Headers | Record<string, string>,
): Record<string, string> {
	const plain: Record<string, string> = {}
	if (headers instanceof Headers) {
		for (const [name, value] of headers.entries()) {
			if (name.toLowerCase() === 'upgrade') continue
			plain[name] = value
		}
	} else if (headers) {
		for (const [name, value] of Object.entries(headers)) {
			if (name.toLowerCase() === 'upgrade') continue
			plain[name] = value
		}
	}
	plain.Upgrade = 'websocket'
	return plain
}

/**
 * Forward `request` through a service binding / Fetcher while keeping a
 * WebSocket upgrade intact under Sentry fetcher instrumentation.
 */
export function fetchPreservingWebSocketUpgrade(
	fetcher: { fetch: typeof fetch },
	request: Request,
): Promise<Response> {
	if (!isWebSocketUpgradeRequest(request)) {
		return fetcher.fetch(request)
	}
	const init: RequestInit = {
		method: request.method,
		headers: webSocketUpgradeFetchHeaders(request.headers),
		redirect: 'manual',
	}
	if (request.body) {
		init.body = request.body
		// Workers require duplex when forwarding a streaming body.
		;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
	}
	return fetcher.fetch(request.url, init)
}
