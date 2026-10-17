/**
 * Hosted CapabilityProxy / local-execute host runtime surface that `--local`
 * must cover. Keep in sync with kody-hq/kody:
 *
 * - `packages/worker/src/open-api/capability-proxy.ts` (JSON `/call` specials)
 * - `POST /v1/capability-proxy/gateway-fetch` (`gatewayFetchStream`)
 * - `docs/contributing/contracts/cli-streaming-gateway-fetch.md`
 * - `docs/contributing/contracts/cli-local-credential-runtime.md`
 *
 * Generic MCP tools (`kody.emailSend`, …) hop through the JSON Proxy and are
 * not listed here. Prefix families (`packageStorage*`, `packageSecret*`,
 * `credentialClient*`, `kody.mcp.*`) are listed once as patterns.
 */

/** Special-cased CapabilityProxy JSON `/call` paths (exact). */
export const hostedCapabilityProxySpecialFunctions = [
	'kody.authenticatedFetch',
	'kody.gatewayFetch',
	'kody.oauthClientCredentials',
	'workflows.create',
] as const

/** Prefix families served by CapabilityProxy JSON `/call`. */
export const hostedCapabilityProxySpecialPrefixes = [
	'kody.packageStorage',
	'kody.packageSecret',
	'kody.credentialClient',
	'kody.mcp.',
] as const

/**
 * Host methods that cannot use the JSON `/call` Proxy hop. The CLI workerd
 * `kody:runtime` must implement these (streaming body / real `Response`).
 */
export const hostedLocalHostSpecialFunctions = [
	'kody.gatewayFetchStream',
] as const

/**
 * Full audit list: every hosted special the CLI `--local` host must support
 * (Proxy hop, dedicated host method, or documented prefix family).
 */
export const hostedLocalExecuteRuntimeSurface = [
	...hostedCapabilityProxySpecialFunctions,
	...hostedCapabilityProxySpecialPrefixes,
	...hostedLocalHostSpecialFunctions,
] as const

export type HostedLocalExecuteRuntimeSurface =
	(typeof hostedLocalExecuteRuntimeSurface)[number]

/**
 * CLI `--local` implementations that are more than the generic JSON Proxy.
 * Drift tests assert these markers appear in the workerd runtime source.
 */
export const localHostImplementedRuntimeMarkers = [
	{
		id: 'kody.gatewayFetchStream',
		/** Dedicated streaming host method (not Proxy → `/call`). */
		sourceMarker: 'gatewayFetchStream',
		bridgeMarker: '/gateway-fetch',
	},
	{
		id: 'kody.authenticatedFetch',
		sourceMarker: 'createAuthenticatedFetch',
		bridgeMarker: null,
	},
	{
		id: 'kody.oauthClientCredentials',
		sourceMarker: 'oauthClientCredentials',
		bridgeMarker: null,
	},
	{
		id: 'kody.credentialClient*',
		sourceMarker: 'credentialClientOpen',
		bridgeMarker: null,
	},
	{
		id: 'kody.gatewayFetch',
		/** JSON hop via Proxy; shim calls `kody.gatewayFetch`. */
		sourceMarker: "__kodyNamespace(['kody'])",
		bridgeMarker: '/call',
	},
] as const
