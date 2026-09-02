import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import {
	anonymousHtmlCacheControl,
	anonymousVisibilityGatedCacheControl,
	isCacheableAnonymousPath,
	requestHasSessionCookie,
} from '#app/anonymous-html-cache.ts'
import { prefersMarkdown } from '#app/markdown-negotiation.ts'

export const anonymousHtmlEdgeCacheHeader = 'X-Kody-Cache'
export const anonymousHtmlCacheAcceptParam = '__accept'
export const anonymousHtmlCacheAcceptHtml = 'html'

const browserVaryStorageHeader = 'X-Kody-Browser-Vary'

type AnonymousHtmlCacheEnv = {
	APP_BASE_URL?: string | null
	PACKAGE_APP_BASE_URL?: string | null
	PACKAGE_APP_LEGACY_HOSTS?: string | null
	PACKAGE_APP_LEGACY_REDIRECT?: string | null
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

function requestBypassesAnonymousHtmlCache(request: Request) {
	const cacheControl = request.headers.get('Cache-Control') ?? ''
	return /\bno-cache\b/i.test(cacheControl)
}

export function isAnonymousHtmlCacheRequest(request: Request) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false
	if (request.headers.has('Authorization')) return false
	if (requestHasSessionCookie(request)) return false
	if (requestBypassesAnonymousHtmlCache(request)) return false
	if (prefersMarkdown(request)) return false
	let pathname: string
	try {
		pathname = new URL(request.url).pathname
	} catch {
		return false
	}
	return isCacheableAnonymousPath(pathname)
}

export function buildAnonymousHtmlCacheKey(
	request: Request,
	env: AnonymousHtmlCacheEnv,
) {
	const url = new URL(request.url)
	const origin = getCanonicalAppBaseUrl({ env, requestUrl: url })
	url.searchParams.set(
		anonymousHtmlCacheAcceptParam,
		anonymousHtmlCacheAcceptHtml,
	)
	return new Request(`${origin}${url.pathname}${url.search}`, {
		method: 'GET',
	})
}

export function isAnonymousHtmlCacheStoreable(response: Response) {
	if (response.status !== 200) return false
	if (response.headers.has('Set-Cookie')) return false
	const contentType = response.headers.get('Content-Type') ?? ''
	if (!contentType.toLowerCase().includes('text/html')) return false
	const cacheControl = response.headers.get('Cache-Control')
	return (
		cacheControl === anonymousHtmlCacheControl ||
		cacheControl === anonymousVisibilityGatedCacheControl
	)
}

function stripCookieVary(headers: Headers) {
	const vary = headers.get('Vary')
	if (!vary) return
	const parts = vary
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0 && part.toLowerCase() !== 'cookie')
	if (parts.length === 0) headers.delete('Vary')
	else headers.set('Vary', parts.join(', '))
}

function cloneResponseForAnonymousHtmlCache(response: Response) {
	const headers = new Headers(response.headers)
	headers.delete(anonymousHtmlEdgeCacheHeader)
	const originalVary = headers.get('Vary')
	if (originalVary) {
		headers.set(browserVaryStorageHeader, originalVary)
	}
	stripCookieVary(headers)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function withAnonymousHtmlCacheLookup(
	response: Response,
	lookup: 'HIT' | 'MISS',
	method: string,
) {
	const headers = new Headers(response.headers)
	if (lookup === 'HIT') {
		const storedVary = headers.get(browserVaryStorageHeader)
		headers.delete(browserVaryStorageHeader)
		if (storedVary) {
			headers.set('Vary', storedVary)
		} else {
			headers.set('Vary', 'Cookie')
		}
	}
	headers.set(anonymousHtmlEdgeCacheHeader, lookup)
	if (method === 'HEAD') {
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function workerDefaultCache(): Cache | null {
	if (typeof caches === 'undefined') return null
	const store = caches as CacheStorage & { default?: Cache }
	return store.default ?? null
}

export async function serveAnonymousHtmlFromCache(
	request: Request,
	env: AnonymousHtmlCacheEnv,
	ctx: ExecutionContext,
	next: () => Promise<Response>,
): Promise<Response> {
	const eligible = isAnonymousHtmlCacheRequest(request)
	if (!eligible) return next()

	const cacheKey = buildAnonymousHtmlCacheKey(request, env)
	const cache = workerDefaultCache()
	if (cache) {
		const cached = await cache.match(cacheKey).catch(() => undefined)
		if (cached) {
			return withAnonymousHtmlCacheLookup(cached, 'HIT', request.method)
		}
	}

	const response = await next()
	const withMiss = withAnonymousHtmlCacheLookup(
		response,
		'MISS',
		request.method,
	)
	if (
		request.method === 'GET' &&
		cache &&
		isAnonymousHtmlCacheStoreable(withMiss)
	) {
		const stored = cloneResponseForAnonymousHtmlCache(withMiss.clone())
		ctx.waitUntil(
			cache.put(cacheKey, stored).catch((error: unknown) => {
				console.debug('anonymous-html-cache-put-failed', error)
			}),
		)
	}
	return withMiss
}
