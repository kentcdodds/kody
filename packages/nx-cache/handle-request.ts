import { readBearerToken, timingSafeEqualString } from './timing-safe.ts'
import { type NxCacheEnv, type NxCacheStore } from './nx-cache-types.ts'

const HASH_PATTERN = /^[a-fA-F0-9]{16,128}$/
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

export function parseCacheHash(pathname: string): string | null {
	const match = /^\/v1\/cache\/([^/]+)$/.exec(pathname)
	if (!match?.[1]) return null
	if (!HASH_PATTERN.test(match[1])) return null
	return match[1]
}

export async function authorizeCacheRequest(
	request: Request,
	accessToken: string | undefined,
): Promise<Response | null> {
	const configured = accessToken?.trim() ?? ''
	if (!configured) {
		return new Response('Nx cache is not configured', { status: 503 })
	}
	const bearer = readBearerToken(request)
	if (bearer === null || !(await timingSafeEqualString(bearer, configured))) {
		return new Response('Unauthorized', { status: 401 })
	}
	return null
}

export async function handleNxCacheRequest(
	request: Request,
	env: Pick<NxCacheEnv, 'CACHE_ACCESS_TOKEN' | 'BUILD_COMMIT'>,
	store: NxCacheStore,
): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		return Response.json(
			{ ok: true, commit: env.BUILD_COMMIT ?? null },
			{ headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const hash = parseCacheHash(url.pathname)
	if (!hash) {
		return new Response('Not found', { status: 404 })
	}

	const unauthorized = await authorizeCacheRequest(
		request,
		env.CACHE_ACCESS_TOKEN,
	)
	if (unauthorized) return unauthorized

	if (request.method === 'GET') {
		const object = await store.get(hash)
		if (!object)
			return new Response('The record was not found', { status: 404 })
		return new Response(object.body, {
			status: 200,
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(object.size),
			},
		})
	}

	if (request.method === 'PUT') {
		const contentLengthHeader = request.headers.get('content-length')
		if (!contentLengthHeader) {
			return new Response('Content-Length is required', { status: 400 })
		}
		const contentLength = Number(contentLengthHeader)
		if (!Number.isInteger(contentLength) || contentLength < 0) {
			return new Response('Content-Length is invalid', { status: 400 })
		}
		if (contentLength > MAX_ARTIFACT_BYTES) {
			return new Response('Artifact exceeds 100MB limit', { status: 413 })
		}
		if (!request.body) {
			return new Response('Request body is required', { status: 400 })
		}
		const result = await store.putIfAbsent(hash, request.body)
		if (result === 'exists') {
			return new Response('Cannot override an existing record', {
				status: 409,
			})
		}
		return new Response(null, { status: 200 })
	}

	return new Response('Method not allowed', { status: 405 })
}
