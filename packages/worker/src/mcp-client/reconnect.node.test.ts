import { expect, test } from 'vitest'
import { reconnectMcpServerOptions } from './reconnect.ts'
import { modernMcpProtocolVersion } from './transport-session.ts'

test('reconnect drops sessionId, protocolVersion, and discoverResult', () => {
	const reconnected = reconnectMcpServerOptions({
		client: {
			capabilities: { elicitation: { form: {} } },
			versionNegotiation: { mode: 'legacy' },
		},
		transport: {
			type: 'auto',
			sessionId: 'stale-2025-session',
			protocolVersion: '2025-11-25',
			headers: { 'X-Test': 'preserved' },
		},
		discoverResult: {
			supportedVersions: [modernMcpProtocolVersion],
			capabilities: { tools: {} },
		},
	})

	expect(reconnected.transport.sessionId).toBeUndefined()
	expect(reconnected.transport.protocolVersion).toBeUndefined()
	expect(reconnected.transport.headers).toEqual({ 'X-Test': 'preserved' })
	expect(reconnected.transport.type).toBe('auto')
	expect(reconnected.client.versionNegotiation).toEqual({ mode: 'auto' })
	expect(reconnected.client.capabilities).toEqual({
		elicitation: { form: {} },
	})
	expect('discoverResult' in reconnected).toBe(false)
})
