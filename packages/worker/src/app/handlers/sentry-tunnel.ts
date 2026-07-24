import { type Action } from 'remix/router'
import { type routes } from '#app/routes.ts'

/**
 * Same-origin Sentry tunnel for the browser SDK.
 *
 * The first-party CSP pins `connect-src 'self'`, so the browser cannot post
 * envelopes to Sentry ingest directly. The client SDK is configured with
 * `tunnel: '/sentry-tunnel'` and this handler forwards envelopes server-side.
 *
 * Abuse safety: the envelope header's `dsn` must exactly match the Worker's
 * own `SENTRY_DSN`, so this can only ever forward to Kody's Sentry project —
 * it is not an open proxy. Bodies are capped because replay payloads are
 * attacker-length-controlled at the HTTP layer.
 */

/** Replay segments are the largest envelopes; 10 MB leaves ample headroom. */
const maxEnvelopeBytes = 10 * 1024 * 1024

type SentryTunnelEnv = {
	SENTRY_DSN?: string
}

export function buildEnvelopeIngestUrl(dsn: string): string | null {
	try {
		const dsnUrl = new URL(dsn)
		// Self-hosted Sentry may live under a base path:
		// https://key@host/base/123 -> https://host/base/api/123/envelope/
		const segments = dsnUrl.pathname.split('/').filter(Boolean)
		const projectId = segments.pop()
		if (!projectId) return null
		const basePath = segments.length > 0 ? `/${segments.join('/')}` : ''
		return `https://${dsnUrl.host}${basePath}/api/${projectId}/envelope/`
	} catch {
		return null
	}
}

export function createSentryTunnelHandler(appEnv: SentryTunnelEnv) {
	return {
		middleware: [],
		async handler({ request }) {
			const configuredDsn = appEnv.SENTRY_DSN?.trim()
			if (!configuredDsn) {
				return new Response('Not Found', { status: 404 })
			}

			const contentLength = Number(request.headers.get('content-length') ?? 0)
			if (contentLength > maxEnvelopeBytes) {
				return new Response('Payload Too Large', { status: 413 })
			}

			const body = await request.arrayBuffer()
			if (body.byteLength > maxEnvelopeBytes) {
				return new Response('Payload Too Large', { status: 413 })
			}

			// The envelope header is the first newline-delimited JSON line.
			const headerEnd = new Uint8Array(body).indexOf(0x0a)
			const headerText = new TextDecoder().decode(
				headerEnd === -1 ? body : body.slice(0, headerEnd),
			)
			let envelopeDsn: unknown
			try {
				const header = JSON.parse(headerText) as { dsn?: unknown }
				envelopeDsn = header.dsn
			} catch {
				return new Response('Malformed envelope', { status: 400 })
			}
			if (
				typeof envelopeDsn !== 'string' ||
				envelopeDsn.trim() !== configuredDsn
			) {
				return new Response('Forbidden', { status: 403 })
			}

			const ingestUrl = buildEnvelopeIngestUrl(configuredDsn)
			if (!ingestUrl) {
				return new Response('Not Found', { status: 404 })
			}

			try {
				const upstream = await fetch(ingestUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/x-sentry-envelope' },
					body,
				})
				return new Response(null, { status: upstream.ok ? 200 : 502 })
			} catch (error) {
				console.warn('sentry-tunnel-forward-failed', error)
				return new Response(null, { status: 502 })
			}
		},
	} satisfies Action<typeof routes.sentryTunnel>
}
