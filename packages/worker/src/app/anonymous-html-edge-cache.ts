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

export function isAnonymousHtmlCacheRequest(
	request: Request,
	env: AnonymousHtmlCacheEnv,
) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false
	if (request.headers.has('Authorization')) return false
	if (requestHasSessionCookie(request)) return false
	if (requestBypassesAnonymousHtmlCache(request)) return false
	if (prefersMarkdown(request)) return false
	let url: URL
	try {
		url = new URL(request.url)
	} catch {
		return false
	}
	// Legacy app hosts and package-app hosts have their own handlers (308
	// redirects, package apps) that must run on every request; only the
	// canonical first-party origin is safe to answer from the shared cache.
	if (url.origin !== getCanonicalAppBaseUrl({ env, requestUrl: url })) {
		return false
	}
	return isCacheableAnonymousPath(url.pathname)
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

/**
 * A streamed SSR document that fails part-way (render error, HMR mid-flight,
 * client abort) can still end cleanly at whatever bytes were written. Only a
 * body that reached the closing `</html>` is a document worth sharing; a
 * shorter one served as a HIT is a blank page for every anonymous visitor
 * until the entry expires.
 */
export function isCompleteHtmlDocument(html: string) {
	return /<\/html\s*>/i.test(html)
}

export function buildAnonymousHtmlCacheEntry(response: Response, html: string) {
	const headers = new Headers(response.headers)
	headers.delete(anonymousHtmlEdgeCacheHeader)
	const originalVary = headers.get('Vary')
	if (originalVary) {
		headers.set(browserVaryStorageHeader, originalVary)
	}
	stripCookieVary(headers)
	return new Response(html, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

async function storeCompleteAnonymousHtml(
	cache: Cache,
	cacheKey: Request,
	response: Response,
) {
	// Buffer first: an errored or truncated body must never reach `put`.
	const html = await response.text()
	if (!isCompleteHtmlDocument(html)) {
		console.warn('anonymous-html-cache-skip-incomplete', {
			url: cacheKey.url,
			bytes: html.length,
		})
		return
	}
	await cache.put(cacheKey, buildAnonymousHtmlCacheEntry(response, html))
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
	const eligible = isAnonymousHtmlCacheRequest(request, env)
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
		ctx.waitUntil(
			storeCompleteAnonymousHtml(cache, cacheKey, withMiss.clone()).catch(
				(error: unknown) => {
					console.debug('anonymous-html-cache-put-failed', error)
				},
			),
		)
	}
	return withMiss
}
