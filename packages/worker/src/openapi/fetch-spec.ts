import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	BoundedBodyTooLargeError,
	readBoundedBody,
} from '#mcp/capabilities/integrations/read-bounded-body.ts'
import {
	executeGatewayFetch,
	type FetchGatewayEnv,
	type FetchGatewayProps,
} from '#mcp/fetch-gateway.ts'

export const defaultOpenApiSpecMaxBytes = 4_000_000
export const defaultOpenApiSpecTimeoutMs = 30_000
const maxRedirectHops = 5

/** Spec fetches egress through the fetch gateway; there is no direct `fetch` path. */
export type OpenApiSpecFetchGateway = {
	env: FetchGatewayEnv
	props: FetchGatewayProps
	/** Test seam; the gateway defaults to the global `fetch`. */
	globalFetch?: typeof fetch
	waitUntil?: (promise: Promise<unknown>) => void
}

function assertHttpsSpecUrl(specUrl: string): URL {
	let url: URL
	try {
		url = new URL(specUrl)
	} catch {
		throw new Error(`OpenAPI spec URL is not a valid URL: ${specUrl}`)
	}

	if (url.protocol !== 'https:') {
		throw new Error(
			`OpenAPI spec URL must use https (got ${url.protocol || 'unknown protocol'})`,
		)
	}

	if (url.username || url.password) {
		throw new Error(
			'OpenAPI spec URL must not include embedded credentials (username/password)',
		)
	}

	return url
}

function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400
}

export async function fetchOpenApiSpecText(input: {
	specUrl: string
	gateway: OpenApiSpecFetchGateway
	maxBytes?: number
	timeoutMs?: number
}): Promise<string> {
	let url = assertHttpsSpecUrl(input.specUrl)
	const maxBytes = input.maxBytes ?? defaultOpenApiSpecMaxBytes
	const timeoutMs = input.timeoutMs ?? defaultOpenApiSpecTimeoutMs

	let response: Response
	let redirected = false
	try {
		for (let hop = 0; ; hop += 1) {
			response = await executeGatewayFetch({
				env: input.gateway.env,
				props: input.gateway.props,
				globalFetch: input.gateway.globalFetch,
				waitUntil: input.gateway.waitUntil,
				timeoutMs,
				request: new Request(url.toString(), {
					headers: {
						Accept: 'application/json, application/yaml, text/yaml, */*',
					},
					redirect: 'manual',
					signal: AbortSignal.timeout(timeoutMs),
				}),
			})

			if (!isRedirectStatus(response.status)) {
				break
			}

			void response.body?.cancel().catch(() => {})

			if (hop >= maxRedirectHops) {
				throw new Error(
					`OpenAPI spec fetch failed: too many redirects (max ${maxRedirectHops})`,
				)
			}

			const location = response.headers.get('location')
			if (location == null || location.trim().length === 0) {
				throw new Error(
					'OpenAPI spec fetch failed: redirect response missing Location header',
				)
			}

			const nextUrl = new URL(location, url)
			url = assertHttpsSpecUrl(nextUrl.toString())
			redirected = true
		}
	} catch (cause) {
		if (
			cause instanceof Error &&
			cause.message.startsWith('OpenAPI spec fetch failed:')
		) {
			throw cause
		}
		const message = getErrorMessage(cause)
		throw new Error(`OpenAPI spec fetch failed: ${message}`)
	}

	if (!response.ok) {
		// Neither the redirect destination nor its status is reported back: both
		// would turn a redirecting spec URL into a probe of where the chain landed.
		throw new Error(
			redirected
				? 'OpenAPI spec fetch failed: redirect destination did not return the spec'
				: `OpenAPI spec fetch failed: HTTP ${response.status} for ${input.specUrl}`,
		)
	}

	try {
		return await readBoundedBody(response, maxBytes)
	} catch (cause) {
		if (cause instanceof BoundedBodyTooLargeError) {
			throw new Error(`OpenAPI spec fetch failed: ${cause.message}`)
		}
		throw cause
	}
}
