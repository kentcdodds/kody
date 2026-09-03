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
const inertHandler: ExportedHandler<Env> = {
	fetch() {
		return Promise.resolve(new Response('Not Found', { status: 404 }))
	},
}

/**
 * Resolve the provider's `OAuthHelpers` for the current execution context.
 *
 * `@cloudflare/workers-oauth-provider` injects `env.OAUTH_PROVIDER` only
 * inside its own `fetch` wrapper on origin. Scheduled lanes, RPC entrypoints
 * (`JobsHost.runScheduledLane`), and capabilities served from the sessionful
 * `MCP` Durable Object on kody-platform run outside it, so they build the same
 * `OAuthHelpersImpl` through the library's `getOAuthApi` with the shared
 * options. The library is imported lazily: it is not on the platform/runtime
 * startup path and only loads when a non-fetch caller actually needs it.
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
	const { getOAuthApi } = await import('@cloudflare/workers-oauth-provider')
	return getOAuthApi<Env>(
		{
			...sharedOAuthProviderOptions,
			apiHandler: inertHandler,
			defaultHandler: inertHandler,
		},
		env,
	)
}
