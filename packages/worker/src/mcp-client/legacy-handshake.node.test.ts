import { expect, test } from 'vitest'
import {
	readMcpVersionNegotiationMode,
	shouldKeepPersistedLegacyHandshake,
	shouldRetryLegacyHandshake,
} from './legacy-handshake.ts'
import { reconnectMcpServerOptions } from './reconnect.ts'

test('legacy handshake retry is only for auto catalog that never reaches ready', () => {
	expect(readMcpVersionNegotiationMode(undefined)).toBe('auto')
	expect(
		readMcpVersionNegotiationMode({
			versionNegotiation: { mode: 'auto' },
		}),
	).toBe('auto')
	expect(
		readMcpVersionNegotiationMode({
			versionNegotiation: { mode: 'legacy' },
		}),
	).toBe('legacy')
	expect(
		shouldRetryLegacyHandshake({
			state: 'connected',
			client: { versionNegotiation: { mode: 'auto' } },
		}),
	).toBe(true)
	expect(
		shouldRetryLegacyHandshake({
			state: 'discovering',
			client: { versionNegotiation: { mode: 'auto' } },
		}),
	).toBe(true)
	expect(
		shouldRetryLegacyHandshake({
			state: 'ready',
			client: { versionNegotiation: { mode: 'auto' } },
		}),
	).toBe(false)
	expect(
		shouldRetryLegacyHandshake({
			state: 'connected',
			client: { versionNegotiation: { mode: 'legacy' } },
		}),
	).toBe(false)
	expect(
		shouldKeepPersistedLegacyHandshake({
			serverId: 'feeds',
			keepLegacyHandshakeIds: new Set(['analytics']),
		}),
	).toBe(false)

	const legacy = reconnectMcpServerOptions(
		{
			client: { capabilities: { elicitation: { form: {} } } },
			transport: {
				type: 'auto',
				sessionId: 'stale',
				protocolVersion: '2025-11-25',
				headers: { Authorization: 'Bearer token' },
			},
		},
		'legacy',
	)
	expect(legacy.client).toEqual({
		capabilities: { elicitation: { form: {} } },
		versionNegotiation: { mode: 'legacy' },
	})
	expect(legacy.transport).toEqual({
		type: 'auto',
		headers: { Authorization: 'Bearer token' },
	})
})
