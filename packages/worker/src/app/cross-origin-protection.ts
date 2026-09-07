import { cop } from 'remix/middleware/cop'

/**
 * Remix COP on the app router. MCP, OAuth, package apps, and connectors are
 * handled in `index.ts` before this router, so they never see this middleware.
 *
 * Bypass only the Remix-mapped endpoints that are supposed to accept
 * cross-origin browser or provider POSTs (webhooks, the Sentry tunnel, and
 * RFC 8058 one-click unsubscribe).
 */
export const remixCrossOriginProtection = cop({
	insecureBypassPatterns: [
		'/webhooks/{name}',
		'/{username}/webhooks/{rest...}',
		'/sentry-tunnel',
		'/unsubscribe/tips',
	],
})
