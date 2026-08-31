/**
 * PKCE is optional for confidential clients, but when a `code_challenge` is
 * present it must use the S256 method. The `plain` method offers no protection
 * against authorization-code interception, so we reject it.
 *
 * `@cloudflare/workers-oauth-provider` 0.10+ defaults `allowPlainPKCE` to
 * false (S256-only discovery and challenges) while still allowing
 * confidential clients to omit PKCE. This check stays as defense in depth so
 * authorize still rejects `plain` even if a future provider default changes.
 * Do not set `allowPlainPKCE: true`.
 *
 * The input type is structural (not the provider's `AuthRequest`) so this
 * module stays importable in the plain-Node test pool — the provider package
 * imports `cloudflare:` modules at load time, and the lint fixer rewrites
 * `import type` statements into inline type specifiers that vitest's transform
 * does not erase. Drift protection against provider field renames lives at the
 * call site in `oauth-handlers.ts`, which reads the two fields off a typed
 * `AuthRequest` explicitly.
 */
export function getPkceValidationError(input: {
	codeChallenge?: string
	codeChallengeMethod?: string
}): string | null {
	if (input.codeChallenge && input.codeChallengeMethod !== 'S256') {
		return 'PKCE code_challenge_method must be S256.'
	}
	return null
}
