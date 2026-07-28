/**
 * First-party HTTP security headers.
 *
 * These are applied to the trusted account/auth UI shell (see
 * `packages/worker/src/app/render.ts`). They are intentionally NOT applied to
 * untrusted, dynamically-authored surfaces such as hosted package apps
 * (`/@username/packages/*`), which execute author-supplied HTML/JS and need
 * their own, looser policies.
 *
 * Content-Security-Policy notes:
 * - `script-src 'self'` (no `'unsafe-inline'`) is the important protection: the
 *   client bundle is loaded as an external module from the same origin, so an
 *   injected inline `<script>` cannot execute. Do NOT add `'unsafe-inline'` to
 *   `script-src`.
 * - `style-src` allows `'unsafe-inline'` because SSR streamed styles arrive as
 *   inline `<style>` tags; style injection is far lower risk than script
 *   injection. Client-side styles use constructable stylesheets, which CSP does
 *   not gate.
 * - `frame-ancestors 'none'` (plus `X-Frame-Options: DENY`) stops clickjacking
 *   of the OAuth consent screen and account pages.
 * - `base-uri`, `object-src`, and `form-action` are locked to prevent base-tag
 *   injection, plugin content, and form exfiltration to third-party origins.
 * - `connect-src 'self'` is safe because the first-party client only calls
 *   same-origin JSON endpoints; all third-party calls happen server-side.
 *   Browser Sentry envelopes stay same-origin too via the `/sentry-tunnel`
 *   route (see `handlers/sentry-tunnel.ts`).
 * - `https://cdn.usefathom.com` in `script-src` and `img-src` allows the
 *   Fathom Analytics tracker (rendered only when FATHOM_SITE_ID is set, see
 *   `ssr-document.tsx`): the script loads from that host and reports
 *   pageviews via an image beacon to the same host.
 * - `worker-src 'self' blob:` exists for Sentry Session Replay's compression
 *   Web Worker, which is created from a blob URL. Spawning a blob worker
 *   already requires script execution, which `script-src 'self'` still gates,
 *   so this does not widen the injection surface.
 */
const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"form-action 'self'",
	"img-src 'self' data: blob: https://cdn.usefathom.com",
	"font-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' https://cdn.usefathom.com",
	"connect-src 'self'",
	"worker-src 'self' blob:",
].join('; ')

export const firstPartySecurityHeaders: Readonly<Record<string, string>> = {
	'Content-Security-Policy': contentSecurityPolicy,
	'X-Frame-Options': 'DENY',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	// Ignored by browsers over plain HTTP (local dev), enforced over HTTPS.
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

export function applyFirstPartySecurityHeaders(response: Response): Response {
	for (const [name, value] of Object.entries(firstPartySecurityHeaders)) {
		response.headers.set(name, value)
	}
	return response
}
