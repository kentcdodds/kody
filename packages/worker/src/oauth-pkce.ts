/**
 * PKCE is optional for confidential clients, but when a `code_challenge` is
 * present it must use the S256 method. The `plain` method offers no protection
 * against authorization-code interception, so we reject it.
 *
 * This is enforced at the application layer rather than via the provider's
 * `allowPlainPKCE` option: that option rejects every authorize request lacking
 * an explicit `code_challenge_method=S256` — including legitimate no-PKCE
 * confidential-client flows — which breaks real MCP clients.
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
