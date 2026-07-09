import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	BoundedBodyTooLargeError,
	readBoundedBody,
} from '#mcp/capabilities/integrations/read-bounded-body.ts'

export const defaultOpenApiSpecMaxBytes = 4_000_000
export const defaultOpenApiSpecTimeoutMs = 30_000
const maxRedirectHops = 5

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
	maxBytes?: number
	timeoutMs?: number
	fetchImpl?: typeof fetch
}): Promise<string> {
	let url = assertHttpsSpecUrl(input.specUrl)
	const maxBytes = input.maxBytes ?? defaultOpenApiSpecMaxBytes
	const timeoutMs = input.timeoutMs ?? defaultOpenApiSpecTimeoutMs
	const fetchImpl = input.fetchImpl ?? fetch

	let response: Response
	try {
		for (let hop = 0; ; hop += 1) {
			response = await fetchImpl(url.toString(), {
				headers: {
					Accept: 'application/json, application/yaml, text/yaml, */*',
				},
				redirect: 'manual',
				signal: AbortSignal.timeout(timeoutMs),
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
		throw new Error(
			`OpenAPI spec fetch failed: HTTP ${response.status} for ${url.toString()}`,
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
