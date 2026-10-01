import {
	parseApiToken,
	readBearerApiToken,
} from '@kody-internal/shared/api-token-format.ts'

/**
 * Edge half of `api.kody.codes`. Everything here runs before the request
 * reaches origin: CORS, rate limits, header stripping, and the body cap.
 * Authentication and the operation itself run in origin's `KodyApi`
 * entrypoint (`packages/worker/src/open-api/`), next to D1.
 */

export type ApiWorkerEnv = {
	KODY_API: Fetcher
	API_IP_RATE_LIMITER?: RateLimit
	API_TOKEN_RATE_LIMITER?: RateLimit
	APP_COMMIT_SHA?: string
}

/** Matches `maxApiRequestBodyBytes` in origin's open-api request parsing. */
export const maxApiRequestBodyBytes = 5 * 1024 * 1024

const forwardedPathPattern = /^\/(?:|openapi\.json|v1(?:\/.*)?)$/
const allowedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After, Allow',
} as const

const corsPreflightHeaders = {
	...corsHeaders,
	'Access-Control-Allow-Methods': allowedMethods.join(', '),
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	'Access-Control-Max-Age': '600',
} as const

function errorResponse(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {},
) {
	return withEdgeHeaders(
		Response.json(
			{ error: { code, message } },
			{ status, headers: { 'Cache-Control': 'no-store', ...headers } },
		),
	)
}

function withEdgeHeaders(response: Response) {
	const headers = new Headers(response.headers)
	for (const [name, value] of Object.entries(corsHeaders)) {
		headers.set(name, value)
	}
	headers.set('X-Content-Type-Options', 'nosniff')
	headers.delete('Set-Cookie')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/**
 * Only the API credential and content negotiation reach origin. Cookies
 * never authenticate the API, and `X-Kody-*` headers are internal fleet
 * signals a public caller must not be able to set.
 */
function buildForwardHeaders(headers: Headers) {
	const forwarded = new Headers()
	for (const name of [
		'Authorization',
		'Content-Type',
		'Accept',
		'User-Agent',
		'CF-Connecting-IP',
	]) {
		const value = headers.get(name)
		if (value !== null) forwarded.set(name, value)
	}
	return forwarded
}

async function readCappedBody(request: Request) {
	const declared = Number(request.headers.get('Content-Length') ?? '0')
	if (declared > maxApiRequestBodyBytes) return null
	if (!request.body) return new Uint8Array(0)
	const reader = request.body.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > maxApiRequestBodyBytes) {
			await reader.cancel()
			return null
		}
		chunks.push(value)
	}
	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return body
}

async function isRateLimited(limiter: RateLimit | undefined, key: string) {
	if (!limiter) return false
	try {
		const { success } = await limiter.limit({ key })
		return !success
	} catch (error) {
		console.warn('api-worker-rate-limit-failed', error)
		return false
	}
}

/**
 * Per-credential rate-limit key. `kody_at_` tokens use the public id (never
 * the secret). Opaque bearers (CLI MCP OAuth) are hashed so the limiter can
 * still key per credential without storing the token value.
 */
async function credentialRateLimitKey(authorization: string | null) {
	const bearer = readBearerApiToken(authorization)
	if (!bearer) return null
	const parsed = parseApiToken(bearer)
	if (parsed) return `token:${parsed.tokenId}`
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(bearer),
	)
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	)
		.join('')
		.slice(0, 32)
	return `bearer:${hex}`
}

async function rateLimitKeys(request: Request) {
	const ip = request.headers.get('CF-Connecting-IP')
	return {
		ip: ip ? `ip:${ip}` : null,
		token: await credentialRateLimitKey(request.headers.get('Authorization')),
	}
}

export async function handleApiEdgeRequest(
	request: Request,
	env: ApiWorkerEnv,
): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		return withEdgeHeaders(
			Response.json(
				{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
				{ headers: { 'Cache-Control': 'no-store' } },
			),
		)
	}
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsPreflightHeaders })
	}
	if (!forwardedPathPattern.test(url.pathname)) {
		return errorResponse(
			404,
			'not_found',
			`No route for ${url.pathname}. See /openapi.json.`,
		)
	}
	if (!allowedMethods.includes(request.method)) {
		return errorResponse(
			405,
			'method_not_allowed',
			`Method ${request.method} is not allowed.`,
			{ Allow: allowedMethods.join(', ') },
		)
	}

	const keys = await rateLimitKeys(request)
	if (
		(keys.ip && (await isRateLimited(env.API_IP_RATE_LIMITER, keys.ip))) ||
		(keys.token &&
			(await isRateLimited(env.API_TOKEN_RATE_LIMITER, keys.token)))
	) {
		return errorResponse(
			429,
			'rate_limited',
			'Too many requests. Retry after a minute.',
			{ 'Retry-After': '60' },
		)
	}

	let body: Uint8Array<ArrayBuffer> | undefined
	if (bodyMethods.has(request.method)) {
		const capped = await readCappedBody(request)
		if (!capped) {
			return errorResponse(
				413,
				'payload_too_large',
				`Request body exceeds ${maxApiRequestBodyBytes} bytes.`,
			)
		}
		body = capped
	}

	const forwarded = new Request(url.toString(), {
		method: request.method,
		headers: buildForwardHeaders(request.headers),
		...(body && body.byteLength > 0 ? { body } : {}),
	})
	try {
		return withEdgeHeaders(await env.KODY_API.fetch(forwarded))
	} catch (error) {
		console.error('api-worker-forward-failed', error)
		return errorResponse(
			503,
			'internal_error',
			'The Kody API is temporarily unavailable.',
			{ 'Retry-After': '5' },
		)
	}
}
