// Type-only namespace import: fully erased, so the provider (and its
// `cloudflare:workers` import) stays off the platform/runtime startup path
// and out of node unit tests until `resolveOAuthHelpers` actually needs it.
import type * as WorkersOAuthProvider from '@cloudflare/workers-oauth-provider'
import { sharedOAuthProviderOptions } from '#worker/oauth-provider-options.ts'

type OAuthHelpers = WorkersOAuthProvider.OAuthHelpers

/**
 * `getOAuthApi` builds a provider instance to validate options, and the
 * constructor insists on request handlers even though the helpers API never
 * routes a request. These stubs satisfy that contract and nothing else.
 */
const inertHandler = {
	fetch() {
		return Promise.resolve(new Response('Not Found', { status: 404 }))
	},
} satisfies ExportedHandler<Env>

/**
 * Resolve the provider's `OAuthHelpers` for the current execution context.
 *
 * `@cloudflare/workers-oauth-provider` injects `env.OAUTH_PROVIDER` only
 * inside its own `fetch` wrapper on origin, and only for the default handler
 * and API routes — `/oauth/token` is handled internally and never gets the
 * injection. Scheduled lanes, RPC entrypoints (`JobsHost.runScheduledLane`),
 * OIDC UserInfo/logout (served before `oauthProvider.fetch`), token-response
 * `id_token` enrichment (runs after that fetch returns), and capabilities
 * served from the sessionful `MCP` Durable Object on kody-platform therefore
 * build the same `OAuthHelpersImpl` through the library's `getOAuthApi` with
 * the shared options. The library loads lazily from the pre-bundled additional module
 * (`tools/build-worker-bundler-modules.ts`): wrangler inlines a plain dynamic
 * `import('@cloudflare/workers-oauth-provider')` into the main module, which
 * would put it on the platform/runtime startup path, whereas the
 * `find_additional_modules` lane uploads it separately so it is only fetched
 * and evaluated when a non-fetch caller actually needs it.
 *
 * Returns `undefined` only when `OAUTH_KV` itself is missing. Callers type
 * `OAUTH_PROVIDER` as the subset of `OAuthHelpers` they consume; the full
 * library type is assignable to every such subset.
 */
export async function resolveOAuthHelpers<Helpers extends object>(
	env: Env & { OAUTH_PROVIDER?: Helpers },
): Promise<Helpers | OAuthHelpers | undefined> {
	if (env.OAUTH_PROVIDER) return env.OAUTH_PROVIDER
	if (!env.OAUTH_KV) return undefined
	const { getOAuthApi } =
		await import('./node_modules/.kody-generated/oauth-provider.mjs')
	return getOAuthApi<Env>(
		{
			...sharedOAuthProviderOptions,
			apiHandler: inertHandler,
			defaultHandler: inertHandler,
		},
		env,
	)
}
