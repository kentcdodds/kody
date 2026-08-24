import { withoutPersistedMcpSession } from './transport-session.ts'

export const outboundMcpVersionNegotiation = { mode: 'auto' as const }

export function outboundMcpClientOptions<T extends object>(
	existing?: T,
): T & { versionNegotiation: { mode: 'auto' } } {
	return {
		...(existing ?? ({} as T)),
		versionNegotiation: outboundMcpVersionNegotiation,
	}
}

/**
 * Reconnect must not reuse a persisted session. A stored 2025 `sessionId`
 * skips `server/discover` and DELETEs on close; a stored `discoverResult`
 * is only a modern prior when it came from a fresh probe, which reconnect
 * does not have yet.
 */
export function reconnectMcpServerOptions<
	T extends {
		client?: object
		transport?: object
		discoverResult?: unknown
	},
>(
	existing?: T,
): {
	client: (T['client'] & object) | { versionNegotiation: { mode: 'auto' } }
	transport: T['transport'] & object
} {
	return {
		client: outboundMcpClientOptions(existing?.client),
		transport: withoutPersistedMcpSession(existing?.transport),
	}
}
