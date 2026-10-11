import { expect, test } from 'vitest'
import { redactEchoedSecrets } from './echo-redaction.ts'

test('a redacted WebSocket upgrade keeps its socket', () => {
	const pair = new WebSocketPair()
	const upgrade = new Response(null, {
		status: 101,
		headers: { 'sec-websocket-protocol': 'token.tok-123' },
		webSocket: pair[0],
	})
	const redacted = redactEchoedSecrets(upgrade, ['tok-123'])
	expect(redacted.status).toBe(101)
	expect(redacted.webSocket).toBe(pair[0])
	expect(redacted.headers.get('sec-websocket-protocol')).toBe(
		'token.[REDACTED SECRET]',
	)
})
