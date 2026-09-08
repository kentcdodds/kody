import { withoutPersistedMcpSession } from './transport-session.ts'

export type McpVersionNegotiationMode = 'auto' | 'legacy'

export const outboundMcpVersionNegotiation = { mode: 'auto' as const }
export const legacyMcpVersionNegotiation = { mode: 'legacy' as const }

function versionNegotiationFor(
	mode: McpVersionNegotiationMode,
): { mode: 'auto' } | { mode: 'legacy' } {
	return mode === 'legacy'
		? legacyMcpVersionNegotiation
		: outboundMcpVersionNegotiation
}

export function outboundMcpClientOptions<T extends object>(
	existing?: T,
	mode: McpVersionNegotiationMode = 'auto',
): T & { versionNegotiation: { mode: 'auto' } | { mode: 'legacy' } } {
	return {
		...(existing ?? ({} as T)),
		versionNegotiation: versionNegotiationFor(mode),
	}
}

/**
 * Reconnect must not reuse a persisted session. A stored 2025 `sessionId`
 * skips `server/discover` and DELETEs on close; a stored `discoverResult`
 * is only a modern prior when it came from a fresh probe, which reconnect
 * does not have yet.
 *
 * Callers that already observed a modern-connect / catalog-timeout can pass
 * `legacy` for a same-server initialize handshake. User reconnect stays
 * `auto` so a later modern-capable server is probed again.
 */
export function reconnectMcpServerOptions<
	T extends {
		client?: object
		transport?: object
		discoverResult?: unknown
	},
>(
	existing?: T,
	mode: McpVersionNegotiationMode = 'auto',
): {
	client:
		| (T['client'] & object)
		| { versionNegotiation: { mode: 'auto' } | { mode: 'legacy' } }
	transport: T['transport'] & object
} {
	return {
		client: outboundMcpClientOptions(existing?.client, mode),
		transport: withoutPersistedMcpSession(existing?.transport),
	}
}
