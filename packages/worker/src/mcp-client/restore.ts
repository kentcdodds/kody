import { isRecord } from '@kody-internal/shared/is-record.ts'
import {
	classifyPersistedMcpSession,
	shouldPersistLegacyMcpSession,
} from './probe-outcome.ts'
import { outboundMcpClientOptions } from './reconnect.ts'
import {
	isFreshModernDiscoverResult,
	type PersistedMcpServerOptions,
	type PersistedMcpTransport,
	withoutPersistedMcpSession,
} from './transport-session.ts'

export function sanitizePersistedMcpServerOptions(
	options: PersistedMcpServerOptions,
): PersistedMcpServerOptions {
	const discoverResult = isFreshModernDiscoverResult(options.discoverResult)
		? options.discoverResult
		: undefined
	const keepLegacySession = shouldPersistLegacyMcpSession(
		classifyPersistedMcpSession(options),
	)
	const transport = withoutPersistedMcpSession(options.transport, {
		keepModernProtocolVersion: discoverResult !== undefined,
	})
	if (!keepLegacySession) {
		delete transport.sessionId
		if (discoverResult === undefined) {
			delete transport.protocolVersion
		}
	}
	const next: PersistedMcpServerOptions = {
		...options,
		client: outboundMcpClientOptions(options.client),
		transport,
	}
	if (discoverResult !== undefined) {
		next.discoverResult = discoverResult
	} else {
		delete next.discoverResult
	}
	return next
}

export function parsePersistedMcpServerOptions(
	value: unknown,
): PersistedMcpServerOptions | null {
	if (typeof value !== 'string' || value.length === 0) return null
	try {
		const parsed: unknown = JSON.parse(value)
		if (!isRecord(parsed)) return null
		const transport = parsed.transport
		return {
			...parsed,
			...(isRecord(transport)
				? { transport: transport as PersistedMcpTransport }
				: {}),
		}
	} catch {
		return null
	}
}

/**
 * Drop stale 2025 session ids from the Agents SDK table before
 * `restoreConnectionsFromStorage`. A stored 2025-11-25 session skips the
 * modern probe and DELETEs on close against modern-only servers.
 */
export function sanitizeStoredMcpSessions(storage: {
	sql: { exec: (query: string, ...bindings: Array<unknown>) => unknown }
}) {
	const rows = [
		...asRows(
			storage.sql.exec('SELECT id, server_options FROM cf_agents_mcp_servers'),
		),
	]
	for (const row of rows) {
		const parsed = parsePersistedMcpServerOptions(row.server_options)
		if (!parsed) continue
		const sanitized = sanitizePersistedMcpServerOptions(parsed)
		if (JSON.stringify(sanitized) === JSON.stringify(parsed)) continue
		storage.sql.exec(
			'UPDATE cf_agents_mcp_servers SET server_options = ? WHERE id = ?',
			JSON.stringify(sanitized),
			row.id,
		)
	}
}

function asRows(value: unknown): Array<{
	id: string
	server_options: string | null
}> {
	if (!isIterable(value)) return []
	return [...value].flatMap((row) => {
		if (!isRecord(row) || typeof row.id !== 'string') return []
		return [
			{
				id: row.id,
				server_options:
					typeof row.server_options === 'string' ? row.server_options : null,
			},
		]
	})
}

function isIterable(value: unknown): value is Iterable<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		Symbol.iterator in value &&
		typeof value[Symbol.iterator] === 'function'
	)
}
