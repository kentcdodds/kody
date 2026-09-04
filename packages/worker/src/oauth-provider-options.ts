// `import type * as` is fully erased under verbatimModuleSyntax; a named
// `{ type X }` import would keep a side-effect import of the provider (and its
// `cloudflare:workers` dependency) on the platform/runtime startup path.
import type * as WorkersOAuthProvider from '@cloudflare/workers-oauth-provider'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'

export type SharedOAuthProviderOptions = Omit<
	WorkersOAuthProvider.OAuthProviderOptions<Env>,
	'apiHandler' | 'apiHandlers' | 'defaultHandler'
>

/**
 * Every `OAuthProvider` option except the request handlers, shared by the
 * origin `fetch` wrapper (`origin-handler.ts`) and the handler-less
 * `getOAuthApi` fallback (`oauth-helpers.ts`) so grant, token, and client
 * storage semantics (endpoints, scopes, TTLs, CIMD) cannot drift between
 * the two. This module must not import the provider at runtime: it sits on
 * the platform/runtime startup path and the provider is deferred there.
 */
export const sharedOAuthProviderOptions = {
	apiRoute: oauthPaths.apiPrefix,
	authorizeEndpoint: oauthPaths.authorize,
	tokenEndpoint: oauthPaths.token,
	clientRegistrationEndpoint: oauthPaths.register,
	scopesSupported: mcpOauthScopes,
	// Client ID Metadata Documents (MCP 2025-11-25 SEP-991): clients may use
	// an HTTPS URL as their client_id instead of registering via DCR. The
	// 2026-07-28 revision deprecates RFC 7591 DCR in favor of CIMD, so both
	// stay enabled: CIMD clients present their URL client_id with no
	// registration step, and clients that do not use CIMD register via
	// /oauth/register. A failed CIMD metadata fetch throws CimdFetchError;
	// authorize maps that to an unknown-client page, and the token endpoint
	// still returns generic invalid_client. Whether a client then registers
	// via DCR is the client's own recovery.
	// Requires the global_fetch_strictly_public compatibility flag (set in
	// wrangler.jsonc) so metadata fetches are SSRF-safe; the provider only
	// advertises CIMD support when both are on.
	clientIdMetadataDocumentEnabled: true,
	// Provider defaults are 30-day refresh tokens and 90-day DCR clients.
	// Explicit `undefined` disables those expiries (omitting the option keeps
	// the defaults). Access tokens stay at the 1-hour default.
	refreshTokenTTL: undefined,
	clientRegistrationTTL: undefined,
	// Do not pin resourceMetadata.resource: preview, local, and production
	// origins all serve MCP. Unconfigured 0.10 inherits an explicit RFC 8707
	// resource (ChatGPT sends `/mcp`) and Kody's authorize handler defaults
	// omitted resources to `/mcp` (Gemini). Custom PRM in origin-handler
	// advertises `<origin>/mcp` so discovery matches that audience.
	// Provider default onError logs every structured OAuth error via console.warn.
	// Keep those responses on the wire without duplicating them into worker logs /
	// test console guards. CIMD lookup failures stay generic on the wire
	// (unknown-client / invalid_client); they are caller or upstream outcomes,
	// not platform defects. Unexpected throws still reach fetch catch + Sentry.
	onError: () => {},
	// 0.10+ defaults allowPlainPKCE to false (S256-only) while still allowing
	// confidential clients to omit PKCE. Do not set allowPlainPKCE: true. App
	// layer getPkceValidationError remains defense in depth. See
	// docs/contributing/security.md.
} satisfies SharedOAuthProviderOptions
