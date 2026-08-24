import { expect, test } from 'vitest'
import {
	sanitizePersistedMcpServerOptions,
	sanitizeStoredMcpSessions,
} from './restore.ts'
import {
	clearLiveMcpTransportSession,
	modernMcpProtocolVersion,
} from './transport-session.ts'

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
	expect(stale.client).toEqual({
		versionNegotiation: { mode: 'auto' },
	})

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

	const updates: Array<{ id: string; options: string }> = []
	sanitizeStoredMcpSessions({
		sql: {
			exec(query: string, ...bindings: Array<unknown>) {
				if (query.startsWith('SELECT')) {
					return [
						{
							id: 'media-rss',
							server_options: JSON.stringify({
								transport: {
									sessionId: 'stale-2025-session',
									protocolVersion: '2025-11-25',
								},
							}),
						},
					]
				}
				updates.push({
					id: String(bindings[1]),
					options: String(bindings[0]),
				})
				return []
			},
		},
	})
	expect(updates).toHaveLength(1)
	expect(updates[0]?.id).toBe('media-rss')
	expect(JSON.parse(updates[0]?.options ?? '{}')).toEqual({
		client: { versionNegotiation: { mode: 'auto' } },
		transport: {},
	})
})
