import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { createAuthenticatedFetch } from '#mcp/execute-modules/kody-runtime-utils.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { buildKodyFns } from '#mcp/run-kody-registry.ts'
import { type ApiInvocationContext } from './context.ts'
import { invalidRequest } from './errors.ts'

/**
 * CapabilityProxy bridge for local `createAuthenticatedFetch`: the CLI / local
 * workerd never sees OAuth access tokens. Host expands
 * `{{integration-token:…}}` through the same fetch gateway cloud execute uses,
 * then returns a JSON-safe response envelope the local runtime reconstructs.
 */

export const capabilityProxyAuthenticatedFetchMaxBodyBytes = 4 * 1024 * 1024

export type CapabilityProxyAuthenticatedFetchRequest = {
	providerName: string
	request: {
		url: string
		method?: string
		headers?: Record<string, string>
		body?: string
	}
}

export type CapabilityProxyAuthenticatedFetchResult = {
	status: number
	statusText: string
	headers: Record<string, string>
	bodyBase64: string
}

export function parseCapabilityProxyAuthenticatedFetchArgs(
	args: ReadonlyArray<unknown>,
): CapabilityProxyAuthenticatedFetchRequest {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		throw invalidRequest(
			'authenticatedFetch requires a single object argument: { providerName, request }.',
		)
	}
	const record = first as Record<string, unknown>
	const providerName =
		typeof record.providerName === 'string' ? record.providerName.trim() : ''
	if (!providerName) {
		throw invalidRequest(
			'authenticatedFetch requires a non-empty providerName.',
		)
	}
	const requestValue = record.request
	if (
		requestValue == null ||
		typeof requestValue !== 'object' ||
		Array.isArray(requestValue)
	) {
		throw invalidRequest(
			'authenticatedFetch requires request: { url, method?, headers?, body? }.',
		)
	}
	const request = requestValue as Record<string, unknown>
	const url = typeof request.url === 'string' ? request.url.trim() : ''
	if (!url) {
		throw invalidRequest(
			'authenticatedFetch request.url must be a non-empty string.',
		)
	}
	const method =
		typeof request.method === 'string' && request.method.trim()
			? request.method.trim()
			: 'GET'
	const headers =
		request.headers != null &&
		typeof request.headers === 'object' &&
		!Array.isArray(request.headers)
			? Object.fromEntries(
					Object.entries(request.headers as Record<string, unknown>).flatMap(
						([key, value]) =>
							typeof value === 'string' ? [[key, value] as const] : [],
					),
				)
			: undefined
	if (request.body !== undefined && typeof request.body !== 'string') {
		throw invalidRequest(
			'authenticatedFetch request.body must be a string when provided.',
		)
	}
	const body = typeof request.body === 'string' ? request.body : undefined
	if (
		body !== undefined &&
		new TextEncoder().encode(body).byteLength >
			capabilityProxyAuthenticatedFetchMaxBodyBytes
	) {
		throw invalidRequest(
			`authenticatedFetch request.body exceeds ${capabilityProxyAuthenticatedFetchMaxBodyBytes} bytes.`,
		)
	}
	return {
		providerName,
		request: {
			url,
			method,
			...(headers ? { headers } : {}),
			...(body !== undefined ? { body } : {}),
		},
	}
}

export async function runCapabilityProxyAuthenticatedFetch(input: {
	ctx: ApiInvocationContext
	args: ReadonlyArray<unknown>
}): Promise<CapabilityProxyAuthenticatedFetchResult> {
	const call = parseCapabilityProxyAuthenticatedFetchArgs(input.args)
	const kody = await buildKodyFns(input.ctx.env, input.ctx.callerContext)
	const storageContext = input.ctx.callerContext.storageContext
	const gatewayFetch: typeof fetch = async (requestInput, init) => {
		const request = new Request(requestInput, init)
		return executeGatewayFetch({
			env: input.ctx.env,
			props: {
				baseUrl: input.ctx.callerContext.baseUrl,
				userId: input.ctx.callerContext.user.userId,
				email: input.ctx.callerContext.user.email,
				storageContext: storageContext
					? {
							sessionId: storageContext.sessionId ?? null,
							appId: storageContext.appId ?? null,
							packageId: storageContext.packageId ?? null,
							storageId: storageContext.storageId ?? null,
						}
					: null,
			},
			request,
			...(input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : {}),
		})
	}
	const authenticatedFetch = await createAuthenticatedFetch(
		kody,
		call.providerName,
		{ fetch: gatewayFetch },
	)
	const response = await authenticatedFetch(call.request.url, {
		method: call.request.method,
		headers: call.request.headers,
		body: call.request.body,
	})
	return serializeAuthenticatedFetchResponse(response)
}

export async function serializeAuthenticatedFetchResponse(
	response: Response,
): Promise<CapabilityProxyAuthenticatedFetchResult> {
	const buffer = new Uint8Array(await response.arrayBuffer())
	if (buffer.byteLength > capabilityProxyAuthenticatedFetchMaxBodyBytes) {
		throw invalidRequest(
			`authenticatedFetch response body exceeds ${capabilityProxyAuthenticatedFetchMaxBodyBytes} bytes for local execute. Use a smaller response projection, or cloud execute for large payloads.`,
		)
	}
	const headers: Record<string, string> = {}
	response.headers.forEach((value, key) => {
		headers[key] = value
	})
	return {
		status: response.status,
		statusText: response.statusText,
		headers,
		bodyBase64: bytesToBase64(buffer),
	}
}
