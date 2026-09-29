import { expect, test } from 'vitest'
import {
	sanitizePersistedMcpServerOptions,
	sanitizeStoredMcpSessions,
} from './restore.ts'
import {
	clearLiveMcpTransportSession,
	modernMcpProtocolVersion,
} from './transport-session.ts'

function sanitizeStoredRow(
	row: { id: string; serverOptions: object },
	options?: Parameters<typeof sanitizeStoredMcpSessions>[1],
) {
	const updates: Array<{ id: string; options: unknown }> = []
	sanitizeStoredMcpSessions(
		{
			sql: {
				exec(query: string, ...bindings: Array<unknown>) {
					if (query.startsWith('SELECT')) {
						return [
							{ id: row.id, server_options: JSON.stringify(row.serverOptions) },
						]
					}
					updates.push({
						id: String(bindings[1]),
						options: JSON.parse(String(bindings[0])),
					})
					return []
				},
			},
		},
		options,
	)
	return updates
}

const legacyClient = { versionNegotiation: { mode: 'legacy' as const } }
const autoClient = { versionNegotiation: { mode: 'auto' } }

test('restore and live session sanitization clears stale 2025 state and keeps fresh modern discoverResult', () => {
	const stale = sanitizePersistedMcpServerOptions({
		transport: {
			type: 'auto',
			sessionId: 'stale-2025-session',
			protocolVersion: '2025-11-25',
		},
		discoverResult: { supportedVersions: ['2025-11-25'] },
	})
	expect(stale.transport?.sessionId).toBeUndefined()
	expect(stale.transport?.protocolVersion).toBeUndefined()
	expect(stale.discoverResult).toBeUndefined()
	expect(stale.client).toEqual(autoClient)

	const modernDiscoverResult = {
		supportedVersions: [modernMcpProtocolVersion],
		capabilities: { tools: {} },
	}
	const modern = sanitizePersistedMcpServerOptions({
		client: {
			capabilities: { elicitation: { form: {} } },
			versionNegotiation: { mode: 'legacy' },
		},
		transport: {
			type: 'auto',
			sessionId: 'stateless-should-drop',
			protocolVersion: modernMcpProtocolVersion,
		},
		discoverResult: modernDiscoverResult,
	})
	expect(modern.transport?.sessionId).toBeUndefined()
	expect(modern.transport?.protocolVersion).toBe(modernMcpProtocolVersion)
	expect(modern.discoverResult).toEqual(modernDiscoverResult)
	expect(modern.client).toEqual({
		capabilities: { elicitation: { form: {} } },
		versionNegotiation: { mode: 'auto' },
	})

	const live = {
		cleared: false,
		clearResumedSession() {
			this.cleared = true
		},
		options: {
			transport: {
				sessionId: 'live-2025',
				protocolVersion: '2025-11-25',
			},
			discoverResult: { supportedVersions: ['2025-11-25'] },
		},
	}
	clearLiveMcpTransportSession(live)
	expect(live.cleared).toBe(true)
	expect(live.options.transport.sessionId).toBeUndefined()
	expect(live.options.transport.protocolVersion).toBeUndefined()
	expect(live.options.discoverResult).toBeUndefined()

	expect(
		sanitizeStoredRow({
			id: 'media-rss',
			serverOptions: {
				transport: {
					sessionId: 'stale-2025-session',
					protocolVersion: '2025-11-25',
				},
			},
		}),
	).toEqual([
		{ id: 'media-rss', options: { client: autoClient, transport: {} } },
	])
})

test('restore keeps catalog-timeout legacy only for remembered servers', () => {
	const keepLegacyHandshakeIds = new Set(['analytics'])
	const legacyOptions = {
		client: legacyClient,
		transport: { type: 'auto' as const },
	}
	expect(
		sanitizePersistedMcpServerOptions(legacyOptions, {
			serverId: 'feeds',
			keepLegacyHandshakeIds,
		}).client,
	).toEqual(autoClient)
	expect(
		sanitizePersistedMcpServerOptions(legacyOptions, {
			serverId: 'analytics',
			keepLegacyHandshakeIds,
		}).client,
	).toEqual(legacyClient)

	expect(
		sanitizeStoredRow(
			{
				id: 'analytics',
				serverOptions: {
					client: legacyClient,
					transport: { sessionId: 'stale-2025-session' },
				},
			},
			{ keepLegacyHandshakeIds },
		),
	).toEqual([
		{ id: 'analytics', options: { client: legacyClient, transport: {} } },
	])
})
