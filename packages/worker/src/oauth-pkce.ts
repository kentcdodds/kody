// Fully type-only import statement: it is erased at compile time, so this
// module stays loadable in the plain-Node test pool even though the provider
// package imports `cloudflare:` modules at runtime.
import  { type AuthRequest } from '@cloudflare/workers-oauth-provider'

/**
 * PKCE is optional for confidential clients, but when a `code_challenge` is
 * present it must use the S256 method. The `plain` method offers no protection
 * against authorization-code interception, so we reject it.
 *
 * This is enforced at the application layer rather than via the provider's
 * `allowPlainPKCE` option: that option rejects every authorize request lacking
 * an explicit `code_challenge_method=S256` — including legitimate no-PKCE
 * confidential-client flows — which breaks real MCP clients.
 */
export function getPkceValidationError(
	input: Pick<AuthRequest, 'codeChallenge' | 'codeChallengeMethod'>,
): string | null {
	if (input.codeChallenge && input.codeChallengeMethod !== 'S256') {
		return 'PKCE code_challenge_method must be S256.'
	}
	return null
}
