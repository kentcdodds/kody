import * as Sentry from '@sentry/browser'
import { filterBrowserSentryEvent } from '#client/sentry-browser-filters.ts'
import { type SentryClientConfig } from '#client/sentry-config.ts'

/**
 * Real browser Sentry SDK init. Loaded only via dynamic `import()` from
 * `sentry-client.ts` so `@sentry/*` stays out of the critical-path entry chunk.
 *
 * Privacy defaults match the previous synchronous client: all text masked and
 * all media blocked in replays, error-only Session Replay (no session sample),
 * no PII, envelopes via the same-origin tunnel.
 */
export function initBrowserSentry(config: SentryClientConfig) {
	Sentry.init({
		dsn: config.dsn,
		tunnel: config.tunnel,
		environment: config.environment,
		...(config.release ? { release: config.release } : {}),
		sendDefaultPii: false,
		integrations: [
			Sentry.replayIntegration({
				maskAllText: true,
				blockAllMedia: true,
			}),
		],
		// Error-only replays: nothing is recorded to Sentry for normal
		// sessions; the in-memory buffer is uploaded only when an error
		// happens.
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 1.0,
		// Drop expected browser noise (AbortError aborts, Firefox DOM
		// permission-denied from Replay/hydration on restricted nodes,
		// injected wallet/`__firefox__` globals, Fathom beacon
		// removeChild-on-null, and Chrome extension IPC "Object Not Found
		// Matching Id…") — see filterBrowserSentryEvent /
		// KODY-CLOUDFLARE-23 / KODY-CLOUDFLARE-3Q / KODY-CLOUDFLARE-3S /
		// issues 7639685398, 7648833360, 7648833403, 7653117289,
		// 7655189301.
		beforeSend(event, hint) {
			return filterBrowserSentryEvent(event, hint.originalException)
		},
	})
}

export function captureBrowserException(error: unknown) {
	Sentry.captureException(error)
}
