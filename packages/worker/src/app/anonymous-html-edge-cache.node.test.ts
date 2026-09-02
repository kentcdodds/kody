import { expect, test } from 'vitest'
import {
	anonymousHtmlCacheControl,
	anonymousVisibilityGatedCacheControl,
} from '#app/anonymous-html-cache.ts'
import {
	buildAnonymousHtmlCacheKey,
	isAnonymousHtmlCacheRequest,
	isAnonymousHtmlCacheStoreable,
} from '#app/anonymous-html-edge-cache.ts'

function htmlResponse(input: {
	status?: number
	cacheControl?: string
	contentType?: string
	setCookie?: string
}) {
	const headers = new Headers({
		'Content-Type': input.contentType ?? 'text/html; charset=utf-8',
		'Cache-Control': input.cacheControl ?? anonymousHtmlCacheControl,
		Vary: 'Cookie',
	})
	if (input.setCookie) headers.set('Set-Cookie', input.setCookie)
	return new Response('<html></html>', {
		status: input.status ?? 200,
		headers,
	})
}

test('anonymous HTML Cache API stores only cookie-less 200 HTML with the shared TTL', () => {
	expect(isAnonymousHtmlCacheRequest(new Request('https://kody.codes/'))).toBe(
		true,
	)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', { method: 'HEAD' }),
		),
	).toBe(true)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', { method: 'POST' }),
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { Cookie: 'kody_session=stale' },
			}),
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { Authorization: 'Bearer x' },
			}),
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { 'Cache-Control': 'no-cache' },
			}),
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(new Request('https://kody.codes/login')),
	).toBe(false)

	const key = buildAnonymousHtmlCacheKey(
		new Request('https://preview.example.workers.dev/pricing?utm=1', {
			method: 'HEAD',
		}),
		{ APP_BASE_URL: 'https://kody.codes' },
	)
	expect(key.method).toBe('GET')
	expect(key.url).toBe('https://kody.codes/pricing?utm=1')

	expect(isAnonymousHtmlCacheStoreable(htmlResponse({}))).toBe(true)
	expect(
		isAnonymousHtmlCacheStoreable(
			htmlResponse({ cacheControl: anonymousVisibilityGatedCacheControl }),
		),
	).toBe(true)
	expect(isAnonymousHtmlCacheStoreable(htmlResponse({ status: 404 }))).toBe(
		false,
	)
	expect(
		isAnonymousHtmlCacheStoreable(
			htmlResponse({ setCookie: 'kody_session=x; Path=/' }),
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheStoreable(
			htmlResponse({ contentType: 'application/json' }),
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheStoreable(htmlResponse({ cacheControl: 'no-store' })),
	).toBe(false)
})
