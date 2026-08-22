/**
 * Mirror static `transport.headers` into `transport.requestInit.headers`.
 *
 * `PersistedMcpTransportOptions` accepts a `headers` field and the Agents SDK
 * persists it, but the underlying transports never read it — they only merge
 * `requestInit` into outbound fetches.
 *
 * Without this, a server configured with a static `Authorization` header never
 * receives one, so any MCP server that answers 401 instead of using OAuth can
 * never connect — it fails with no diagnostic, because the client falls back to
 * OAuth discovery and reports the discovery failure rather than the 401.
 *
 * Explicit `requestInit.headers` win so callers can still override a stored
 * value.
 */
export function withStaticTransportHeaders<
	T extends {
		headers?: HeadersInit
		requestInit?: RequestInit
		[key: string]: unknown
	},
>(transport: T): T {
	if (!transport.headers) return transport
	return {
		...transport,
		requestInit: {
			...transport.requestInit,
			headers: {
				...headersToRecord(transport.headers),
				...headersToRecord(transport.requestInit?.headers),
			},
		},
	}
}

function headersToRecord(
	init: HeadersInit | undefined,
): Record<string, string> {
	if (!init) return {}
	return Object.fromEntries(new Headers(init).entries())
}
