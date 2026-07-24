import { afterEach, expect, test, vi } from 'vitest'
import {
	buildEnvelopeIngestUrl,
	createSentryTunnelHandler,
} from './sentry-tunnel.ts'

const configuredDsn = 'https://publickey@o123.ingest.us.sentry.io/456'

function buildEnvelope(dsn?: string) {
	const header = JSON.stringify(dsn ? { dsn } : {})
	return `${header}\n{"type":"event"}\n{"message":"boom"}`
}

function tunnelRequest(body: string | ArrayBuffer) {
	return {
		request: new Request('http://example.com/sentry-tunnel', {
			method: 'POST',
			body,
		}),
		url: new URL('http://example.com/sentry-tunnel'),
	} as unknown as Parameters<
		ReturnType<typeof createSentryTunnelHandler>['handler']
	>[0]
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('buildEnvelopeIngestUrl derives the envelope endpoint from the DSN', () => {
	expect(buildEnvelopeIngestUrl(configuredDsn)).toBe(
		'https://o123.ingest.us.sentry.io/api/456/envelope/',
	)
	expect(buildEnvelopeIngestUrl('not a url')).toBeNull()
	expect(buildEnvelopeIngestUrl('https://key@host.example.com/')).toBeNull()
	// Self-hosted Sentry under a base path keeps the path prefix.
	expect(
		buildEnvelopeIngestUrl('https://key@sentry.example.com/sentry/456'),
	).toBe('https://sentry.example.com/sentry/api/456/envelope/')
})

test('forwards envelopes whose dsn matches the configured DSN', async () => {
	const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
	vi.stubGlobal('fetch', fetchMock)
	const handler = createSentryTunnelHandler({ SENTRY_DSN: configuredDsn })

	const response = await handler.handler(
		tunnelRequest(buildEnvelope(configuredDsn)),
	)

	expect(response.status).toBe(200)
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const [ingestUrl, init] = fetchMock.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	expect(ingestUrl).toBe('https://o123.ingest.us.sentry.io/api/456/envelope/')
	expect(init.method).toBe('POST')
})

test('rejects envelopes for a different DSN without forwarding', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	const handler = createSentryTunnelHandler({ SENTRY_DSN: configuredDsn })

	const response = await handler.handler(
		tunnelRequest(buildEnvelope('https://other@o999.ingest.sentry.io/1')),
	)

	expect(response.status).toBe(403)

	// Truthy non-string dsn values must 403, not crash.
	const nonString = await handler.handler(
		tunnelRequest('{"dsn":{"nested":true}}\n{"type":"event"}'),
	)
	expect(nonString.status).toBe(403)
	expect(fetchMock).not.toHaveBeenCalled()
})

test('returns 404 when no DSN is configured and 400 on malformed envelopes', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)

	const disabled = createSentryTunnelHandler({})
	expect(
		(await disabled.handler(tunnelRequest(buildEnvelope(configuredDsn))))
			.status,
	).toBe(404)

	const enabled = createSentryTunnelHandler({ SENTRY_DSN: configuredDsn })
	expect((await enabled.handler(tunnelRequest('not json\nrest'))).status).toBe(
		400,
	)
	expect(fetchMock).not.toHaveBeenCalled()
})

test('returns 502 when the upstream forward fails', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new Error('network down')
		}),
	)
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const handler = createSentryTunnelHandler({ SENTRY_DSN: configuredDsn })
		const response = await handler.handler(
			tunnelRequest(buildEnvelope(configuredDsn)),
		)
		expect(response.status).toBe(502)
	} finally {
		warnSpy.mockRestore()
	}
})
