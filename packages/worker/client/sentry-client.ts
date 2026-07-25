import * as Sentry from '@sentry/browser'
import {
	filterBrowserAbortSentryEvent,
	isBrowserAbortError,
} from '#client/sentry-browser-filters.ts'
import {
	parseSentryClientConfig,
	SENTRY_CONFIG_META_NAME,
} from '#client/sentry-config.ts'

/**
 * Browser-side Sentry: error capture plus error-only Session Replay.
 *
 * Privacy defaults are strict on purpose — Kody sessions contain personal
 * assistant content (chats, email, secrets pages), so all text is masked and
 * all media blocked in replays, no session-based recording happens (only the
 * ~60s buffer around an error is uploaded), and no PII is attached. Envelopes
 * go through the same-origin `/sentry-tunnel` route, so the first-party CSP
 * (`connect-src 'self'`) stays unchanged.
 *
 * No-ops when the config meta tag is absent (local dev / tests without a
 * DSN). Must never break app boot.
 */
export function initSentryClient(doc: Document) {
	try {
		const content = doc
			.querySelector(`meta[name="${SENTRY_CONFIG_META_NAME}"]`)
			?.getAttribute('content')
		const config = parseSentryClientConfig(content)
		if (!config) return false

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
			// Superseded SPA navigations and user-driven aborts reject in-flight
			// fetches with AbortError. Those are expected and not actionable —
			// see filterBrowserAbortSentryEvent / KODY-CLOUDFLARE-23.
			beforeSend(event, hint) {
				return filterBrowserAbortSentryEvent(event, hint.originalException)
			},
		})
		return true
	} catch (error) {
		console.warn('sentry-client-init-failed', error)
		return false
	}
}

/** Report a caught client error without letting reporting itself throw. */
export function captureClientException(error: unknown) {
	if (isBrowserAbortError(error)) return
	try {
		Sentry.captureException(error)
	} catch {
		// Reporting must never break the app.
	}
}
