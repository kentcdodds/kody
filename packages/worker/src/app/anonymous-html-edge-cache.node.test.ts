import { expect, test } from 'vitest'
import {
	anonymousHtmlCacheControl,
	anonymousVisibilityGatedCacheControl,
} from '#app/anonymous-html-cache.ts'
import {
	anonymousHtmlCacheAcceptHtml,
	anonymousHtmlCacheAcceptParam,
	buildAnonymousHtmlCacheEntry,
	buildAnonymousHtmlCacheKey,
	isAnonymousHtmlCacheRequest,
	isAnonymousHtmlCacheStoreable,
	isCompleteHtmlDocument,
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

const canonicalEnv = {
	APP_BASE_URL: 'https://kody.codes',
	APP_LEGACY_HOSTS: 'kody.codes.legacy.example',
	PACKAGE_APP_BASE_URL: 'https://kody-apps.example',
}

test('anonymous HTML Cache API stores only cookie-less 200 HTML with the shared TTL', () => {
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/'),
			canonicalEnv,
		),
	).toBe(true)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', { method: 'HEAD' }),
			canonicalEnv,
		),
	).toBe(true)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', { method: 'POST' }),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { Cookie: 'kody_session=stale' },
			}),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { Authorization: 'Bearer x' },
			}),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { 'Cache-Control': 'no-cache' },
			}),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/login'),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { Accept: 'text/markdown' },
			}),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/', {
				headers: { Accept: 'text/html' },
			}),
			canonicalEnv,
		),
	).toBe(true)

	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes.legacy.example/'),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody-apps.example/'),
			canonicalEnv,
		),
	).toBe(false)
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://preview.example.workers.dev/pricing'),
			{ APP_BASE_URL: 'https://preview.example.workers.dev' },
		),
	).toBe(true)
	expect(
		isAnonymousHtmlCacheRequest(new Request('http://localhost:3742/'), {}),
	).toBe(true)
	// `npm run dev` and the Playwright web server: a stored page would hide
	// the next edit from an anonymous tab for the stale-while-revalidate window.
	expect(
		isAnonymousHtmlCacheRequest(new Request('http://localhost:3742/'), {
			WRANGLER_IS_LOCAL_DEV: 'true',
		}),
	).toBe(false)

	const htmlKey = buildAnonymousHtmlCacheKey(
		new Request('https://preview.example.workers.dev/pricing?utm=1', {
			method: 'HEAD',
			headers: { Accept: 'text/html' },
		}),
		{ APP_BASE_URL: 'https://kody.codes' },
	)
	expect(htmlKey.method).toBe('GET')
	expect(htmlKey.url).toBe(
		`https://kody.codes/pricing?utm=1&${anonymousHtmlCacheAcceptParam}=${anonymousHtmlCacheAcceptHtml}`,
	)
	const defaultAcceptKey = buildAnonymousHtmlCacheKey(
		new Request('https://preview.example.workers.dev/pricing?utm=1'),
		{ APP_BASE_URL: 'https://kody.codes' },
	)
	expect(defaultAcceptKey.url).toBe(htmlKey.url)

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

test('only a document that reached </html> counts as complete', () => {
	// An SSR stream that failed after committing the doctype ends cleanly at
	// 15 bytes; it must never be stored as the shared anonymous document.
	expect(isCompleteHtmlDocument('<!DOCTYPE html>')).toBe(false)
	expect(isCompleteHtmlDocument('')).toBe(false)
	expect(isCompleteHtmlDocument('<!DOCTYPE html><html><body>')).toBe(false)
	expect(
		isCompleteHtmlDocument(
			'<!DOCTYPE html><html><body></body></html><!-- rmx:flush document -->',
		),
	).toBe(true)
	expect(isCompleteHtmlDocument('<html></HTML >')).toBe(true)
})

test('the stored entry keeps the buffered body and moves Vary aside', async () => {
	const response = new Response('streamed', {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': anonymousHtmlCacheControl,
			Vary: 'Cookie, Accept',
			'X-Kody-Cache': 'MISS',
		},
	})
	const entry = buildAnonymousHtmlCacheEntry(response, '<html></html>')
	await expect(entry.text()).resolves.toBe('<html></html>')
	expect(entry.headers.get('X-Kody-Cache')).toBeNull()
	expect(entry.headers.get('X-Kody-Browser-Vary')).toBe('Cookie, Accept')
	expect(entry.headers.get('Vary')).toBe('Accept')
	expect(entry.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
})
