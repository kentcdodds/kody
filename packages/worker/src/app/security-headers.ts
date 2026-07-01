/**
 * First-party HTTP security headers.
 *
 * These are applied to the trusted account/auth UI shell (see
 * `packages/worker/src/app/render.ts`). They are intentionally NOT applied to
 * untrusted, dynamically-authored surfaces such as hosted package apps
 * (`/@username/packages/*`) or the generated-UI runtime (`/mcp-apps/*`,
 * `/dev/generated-ui`), which execute author-supplied HTML/JS and need their
 * own, looser policies.
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
 */
const contentSecurityPolicy = [
	"default-src 'self'",
	"base-uri 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"form-action 'self'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self'",
	"connect-src 'self'",
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
