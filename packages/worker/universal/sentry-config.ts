/**
 * Shared shape for the browser Sentry config. The server serializes it into a
 * `<meta name="kody:sentry">` tag (see `ssr-document.tsx`); the client reads
 * it back in `sentry-client.ts`. Kept free of `@sentry/browser` imports so the
 * SSR bundle never pulls in the browser SDK.
 */

export const SENTRY_CONFIG_META_NAME = 'kody:sentry'

/** Same-origin envelope tunnel; keeps CSP `connect-src 'self'` intact. */
export const SENTRY_TUNNEL_PATH = '/sentry-tunnel'

export type SentryClientConfig = {
	dsn: string
	environment: string
	release?: string | null
	tunnel: string
}

export function parseSentryClientConfig(
	content: string | null | undefined,
): SentryClientConfig | null {
	if (!content) return null
	try {
		const parsed = JSON.parse(content) as Partial<SentryClientConfig>
		if (
			typeof parsed.dsn !== 'string' ||
			!parsed.dsn ||
			typeof parsed.environment !== 'string' ||
			typeof parsed.tunnel !== 'string' ||
			// Same-origin path only: reject scheme-relative URLs like
			// //evil.example/collect, which start with '/' but leave origin.
			!parsed.tunnel.startsWith('/') ||
			parsed.tunnel.startsWith('//')
		) {
			return null
		}
		return {
			dsn: parsed.dsn,
			environment: parsed.environment,
			release: typeof parsed.release === 'string' ? parsed.release : null,
			tunnel: parsed.tunnel,
		}
	} catch {
		return null
	}
}
