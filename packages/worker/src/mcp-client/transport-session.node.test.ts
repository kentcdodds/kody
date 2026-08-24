import { expect, test } from 'vitest'
import {
	clearLiveMcpTransportSession,
	isFreshModernDiscoverResult,
	isLegacyMcpProtocolVersion,
	isModernMcpProtocolVersion,
	modernMcpProtocolVersion,
	withoutPersistedMcpSession,
} from './transport-session.ts'

const modernDiscoverResult = {
	supportedVersions: [modernMcpProtocolVersion],
	capabilities: { tools: {} },
}

test('stale 2025 session fields are dropped and a fresh modern discoverResult is kept', () => {
	expect(isModernMcpProtocolVersion(modernMcpProtocolVersion)).toBe(true)
	expect(isLegacyMcpProtocolVersion('2025-11-25')).toBe(true)
	expect(isLegacyMcpProtocolVersion(modernMcpProtocolVersion)).toBe(false)
	expect(isFreshModernDiscoverResult(modernDiscoverResult)).toBe(true)
	expect(
		isFreshModernDiscoverResult({ supportedVersions: ['2025-11-25'] }),
	).toBe(false)

	const cleared = withoutPersistedMcpSession({
		type: 'auto',
		sessionId: 'stale-2025-session',
		protocolVersion: '2025-11-25',
		headers: { 'X-Test': 'kept' },
	})
	expect(cleared).toEqual({
		type: 'auto',
		headers: { 'X-Test': 'kept' },
	})

	const modernKept = withoutPersistedMcpSession(
		{
			type: 'streamable-http',
			sessionId: 'should-drop',
			protocolVersion: modernMcpProtocolVersion,
		},
		{ keepModernProtocolVersion: true },
	)
	expect(modernKept.sessionId).toBeUndefined()
	expect(modernKept.protocolVersion).toBe(modernMcpProtocolVersion)

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
})
