/**
 * Session fields the Agents SDK persists on `transport` / `server_options`.
 *
 * Client 2.0.0 skips `server/discover` whenever `transport.sessionId` is set
 * and, on close, DELETEs that session. A stored 2025-11-25 session therefore
 * never probes a server that has moved to 2026-07-28, and the terminate
 * request 405s on modern-only Streamable HTTP.
 */

export const modernMcpProtocolVersion = '2026-07-28'

export type PersistedMcpTransport = {
	type?: string
	sessionId?: string
	protocolVersion?: string
	headers?: HeadersInit
	requestInit?: RequestInit
}

export type PersistedMcpServerOptions = {
	client?: Record<string, unknown>
	transport?: PersistedMcpTransport
	discoverResult?: unknown
}

export function isModernMcpProtocolVersion(value: unknown): boolean {
	return value === modernMcpProtocolVersion
}

export function isLegacyMcpProtocolVersion(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith('2025-')
}

/**
 * A `DiscoverResult` from a successful `server/discover`. The Agents SDK
 * only treats it as a modern prior when `supportedVersions` includes
 * 2026-07-28.
 */
export function isFreshModernDiscoverResult(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false
	const supportedVersions = Reflect.get(value, 'supportedVersions')
	return (
		Array.isArray(supportedVersions) &&
		supportedVersions.includes(modernMcpProtocolVersion)
	)
}

export function withoutPersistedMcpSession<T extends object>(
	transport: T | undefined,
	options?: { keepModernProtocolVersion?: boolean },
): T {
	if (!transport) return {} as T
	const next = { ...transport } as T & {
		sessionId?: string
		protocolVersion?: string
	}
	delete next.sessionId
	if (
		!(
			options?.keepModernProtocolVersion &&
			isModernMcpProtocolVersion(next.protocolVersion)
		)
	) {
		delete next.protocolVersion
	}
	return next
}

export function clearLiveMcpTransportSession(connection: {
	clearResumedSession?: () => void
	options: {
		transport: object
		discoverResult?: unknown
	}
}) {
	connection.clearResumedSession?.()
	const transport = connection.options.transport as {
		sessionId?: string
		protocolVersion?: string
	}
	delete transport.sessionId
	delete transport.protocolVersion
	delete connection.options.discoverResult
}
