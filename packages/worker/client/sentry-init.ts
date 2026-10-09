import * as Sentry from '@sentry/browser'
import { filterBrowserSentryEvent } from '#client/sentry-browser-filters.ts'
import { type SentryClientConfig } from '#universal/sentry-config.ts'

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
				// blockAllMedia's MEDIA_SELECTORS omit iframe. Cross-origin
				// embeds (landing/docs YouTube lite player →
				// youtube-nocookie.com, Turnstile challenge frames, etc.)
				// still fire rrweb onIframeLoad → observeAttachShadow, which
				// reads iframeWindow.Element unguarded and throws into the
				// page (getsentry/sentry-javascript#23795 / KODY-8W). Blocking
				// iframes skips that path (needBlock / isBlocked). Fixed
				// upstream in @sentry/replay 11.5.0 via rrweb 2.44.1; stay on
				// 10.x until a deliberate v11 migration.
				block: ['iframe'],
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
		// removeChild-on-null, Chrome extension IPC "Object Not Found
		// Matching Id…", Chrome/Firefox extension "Receiving end does not
		// exist", extension "Invalid call to runtime.sendMessage(). Tab not
		// found", MetaMask inpage connect failures, MetaMask plain-object
		// "wallet must has at least one account" rejections, Chrome
		// extension "Client has been destroyed" with exclusively
		// chrome-extension frames, Chrome extension TypeError reading
		// `M_ID` with exclusively chrome-extension frames, Twitter/X in-app
		// browser chrome `CONFIG`
		// ReferenceErrors / `sendScrollEvent`→ `window.webkit.messageHandlers`
		// TypeErrors, injected unguarded `meta[property='og:type']` probes
		// from `global code`, and optional Shiki `syntax-highlight-core`
		// dynamic import fetch failures, and resolveFrame fetch network
		// TypeErrors, and local Vite / wrangler HMR loopback sessions,
		// and residual Replay onIframeLoad / observeAttachShadow
		// SecurityError|TypeError after cross-origin iframe Element reads
		// (KODY-8W; primary mitigation is block:['iframe'] above))
		// — see filterBrowserSentryEvent /
		// KODY-CLOUDFLARE-23 / KODY-CLOUDFLARE-3Q / KODY-CLOUDFLARE-3S /
		// KODY-CLOUDFLARE-3X / KODY-CLOUDFLARE-43 / KODY-CLOUDFLARE-46 /
		// KODY-CLOUDFLARE-4F / KODY-CLOUDFLARE-5C / KODY-CLOUDFLARE-5K /
		// KODY-CLOUDFLARE-5W / KODY-CLOUDFLARE-5X / KODY-CLOUDFLARE-5Y /
		// KODY-CLOUDFLARE-64 / KODY-6Z / KODY-8W /
		// issues 7639685398, 7648833360, 7648833403, 7653117289, 7655189301,
		// 7658961865, 7659616372, 7660258027, 7662064169, 7677729361,
		// 7682968915, 7687920474, 7689579030, 7690163947, 7696001937,
		// 7717003182, 7777463624.
		beforeSend(event, hint) {
			return filterBrowserSentryEvent(event, hint.originalException)
		},
	})
}

export function captureBrowserException(error: unknown) {
	Sentry.captureException(error)
}
