import { expect, test, vi } from 'vitest'
import {
	buildEnvelopeIngestUrl,
	createSentryTunnelHandler,
} from './sentry-tunnel.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

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

function stubFetch(fetchMock: ReturnType<typeof vi.fn>) {
	vi.stubGlobal('fetch', fetchMock)
	return {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	}
}

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

test('sentry tunnel forwards matching envelopes and rejects everything else', async () => {
	const forwardMock = vi.fn(async () => new Response(null, { status: 200 }))
	using _okFetch = stubFetch(forwardMock)
	const forwardHandler = createSentryTunnelHandler({
		SENTRY_DSN: configuredDsn,
	})
	const forwarded = await forwardHandler.handler(
		tunnelRequest(buildEnvelope(configuredDsn)),
	)
	expect(forwarded.status).toBe(200)
	expect(forwardMock).toHaveBeenCalledTimes(1)
	const [ingestUrl, init] = forwardMock.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	expect(ingestUrl).toBe('https://o123.ingest.us.sentry.io/api/456/envelope/')
	expect(init.method).toBe('POST')

	const rejectMock = vi.fn()
	using _rejectFetch = stubFetch(rejectMock)
	const rejectHandler = createSentryTunnelHandler({
		SENTRY_DSN: configuredDsn,
	})
	expect(
		(
			await rejectHandler.handler(
				tunnelRequest(buildEnvelope('https://other@o999.ingest.sentry.io/1')),
			)
		).status,
	).toBe(403)
	// Truthy non-string dsn values must 403, not crash.
	expect(
		(
			await rejectHandler.handler(
				tunnelRequest('{"dsn":{"nested":true}}\n{"type":"event"}'),
			)
		).status,
	).toBe(403)
	expect(
		(
			await createSentryTunnelHandler({}).handler(
				tunnelRequest(buildEnvelope(configuredDsn)),
			)
		).status,
	).toBe(404)
	expect(
		(await rejectHandler.handler(tunnelRequest('not json\nrest'))).status,
	).toBe(400)
	expect(rejectMock).not.toHaveBeenCalled()

	const failMock = vi.fn(async () => {
		throw new Error('network down')
	})
	using _failFetch = stubFetch(failMock)
	consoleWarn.mockImplementation(() => {})
	const failHandler = createSentryTunnelHandler({ SENTRY_DSN: configuredDsn })
	expect(
		(await failHandler.handler(tunnelRequest(buildEnvelope(configuredDsn))))
			.status,
	).toBe(502)
})
