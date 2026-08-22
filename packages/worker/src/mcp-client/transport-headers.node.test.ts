import { expect, test } from 'vitest'
import { withStaticTransportHeaders } from './transport-headers.ts'

test('static Authorization headers reach requestInit so transports send them', () => {
	const transport = withStaticTransportHeaders({
		type: 'auto' as const,
		headers: { Authorization: 'Bearer secret-token' },
	})

	// `headers` alone is dropped by StreamableHTTPClientTransport /
	// SSEClientTransport; only `requestInit` is merged into outbound fetches.
	// Keys come back lowercased because they round-trip through `Headers`.
	expect(transport.requestInit?.headers).toEqual({
		authorization: 'Bearer secret-token',
	})
	expect(transport.headers).toEqual({ Authorization: 'Bearer secret-token' })
	expect(transport.type).toBe('auto')

	const withoutHeaders = withStaticTransportHeaders({ type: 'auto' as const })
	expect(withoutHeaders).toEqual({ type: 'auto' })
	expect(withoutHeaders.requestInit).toBeUndefined()

	const withExistingRequestInit = withStaticTransportHeaders({
		headers: { Authorization: 'Bearer stored', 'X-From-Headers': 'yes' },
		requestInit: {
			redirect: 'follow' as const,
			headers: { Authorization: 'Bearer explicit' },
		},
	})
	expect(withExistingRequestInit.requestInit?.redirect).toBe('follow')
	expect(withExistingRequestInit.requestInit?.headers).toEqual({
		authorization: 'Bearer explicit',
		'x-from-headers': 'yes',
	})
})
