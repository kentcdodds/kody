import { exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { anonymousHtmlCacheControl } from '#app/anonymous-html-cache.ts'
import {
	anonymousHtmlEdgeCacheHeader,
	isAnonymousHtmlCacheStoreable,
} from '#app/anonymous-html-edge-cache.ts'

async function workerFetch(request: Request): Promise<Response> {
	return await exports.default.fetch(request)
}

function expectCspPresent(response: Response) {
	expect(response.headers.get('Content-Security-Policy')).toMatch(
		/script-src 'self'/,
	)
}

test('anonymous marketing HTML is stored in caches.default and replayed as HIT', async () => {
	const probe = crypto.randomUUID()
	const pricingUrl = `https://test.kody.dev/pricing?edge-cache=${probe}`
	const missingGuideUrl = `https://test.kody.dev/guides/missing-guide-${probe}`

	const miss = await workerFetch(new Request(pricingUrl))
	expect(miss.status).toBe(200)
	expect(miss.headers.get('Content-Type')).toMatch(/text\/html/i)
	expect(miss.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
	expect(miss.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
	expectCspPresent(miss)
	const missHtml = await miss.text()
	expect(missHtml.length).toBeGreaterThan(0)

	const hit = await workerFetch(new Request(pricingUrl))
	expect(hit.status).toBe(200)
	expect(hit.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
	expect(hit.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
	expect(hit.headers.get('Vary')).toBe(miss.headers.get('Vary'))
	expect(hit.headers.get('Vary')?.toLowerCase()).toContain('cookie')
	expect(hit.headers.get('X-Kody-Browser-Vary')).toBeNull()
	expectCspPresent(hit)
	await expect(hit.text()).resolves.toBe(missHtml)

	const guidesUrl = `https://test.kody.dev/guides?edge-accept=${probe}`
	const htmlGuides = await workerFetch(
		new Request(guidesUrl, { headers: { Accept: 'text/html' } }),
	)
	expect(htmlGuides.status).toBe(200)
	expect(htmlGuides.headers.get('Content-Type')).toMatch(/text\/html/i)
	expect(htmlGuides.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
	expect(htmlGuides.headers.get('Vary')?.toLowerCase()).toContain('cookie')
	expect(htmlGuides.headers.get('Vary')?.toLowerCase()).toContain('accept')
	const htmlGuidesBody = await htmlGuides.text()

	const markdownGuides = await workerFetch(
		new Request(guidesUrl, { headers: { Accept: 'text/markdown' } }),
	)
	expect(markdownGuides.headers.get(anonymousHtmlEdgeCacheHeader)).not.toBe(
		'HIT',
	)
	expect(markdownGuides.headers.get('Content-Type')).toMatch(/text\/markdown/i)
	const markdownBody = await markdownGuides.text()
	expect(markdownBody).not.toBe(htmlGuidesBody)
	expect(markdownBody.startsWith('#')).toBe(true)

	const htmlGuidesHit = await workerFetch(
		new Request(guidesUrl, { headers: { Accept: 'text/html' } }),
	)
	expect(htmlGuidesHit.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
	expect(htmlGuidesHit.headers.get('Vary')).toBe(htmlGuides.headers.get('Vary'))
	await expect(htmlGuidesHit.text()).resolves.toBe(htmlGuidesBody)

	const noStore = { cacheControl: 'no-store' }
	const uncached: Array<
		[string, HeadersInit, { status?: number; cacheControl?: string }]
	> = [
		[pricingUrl, { Cookie: 'kody_session=stale' }, noStore],
		[
			pricingUrl,
			{
				Cookie: 'kody_site_banner_dismiss=11111111-1111-4111-8111-111111111111',
			},
			noStore,
		],
		[pricingUrl, { Authorization: 'Bearer not-a-token' }, {}],
		[pricingUrl, { 'Cache-Control': 'no-cache' }, {}],
		[missingGuideUrl, {}, { status: 404 }],
		[missingGuideUrl, {}, { status: 404 }],
	]
	const outcomes = []
	for (const [url, headers] of uncached) {
		const response = await workerFetch(new Request(url, { headers }))
		outcomes.push({
			hit: response.headers.get(anonymousHtmlEdgeCacheHeader) === 'HIT',
			status: response.status,
			cacheControl: response.headers.get('Cache-Control'),
		})
		await response.body?.cancel()
	}
	expect(outcomes).toMatchObject(
		uncached.map(([, , expected]) => ({ hit: false, ...expected })),
	)

	const setCookieResponse = new Response('<html>set-cookie</html>', {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': anonymousHtmlCacheControl,
			'Set-Cookie': 'kody_session=poison; Path=/',
		},
	})
	expect(isAnonymousHtmlCacheStoreable(setCookieResponse)).toBe(false)
	const setCookieKey = new Request(
		`https://test.kody.dev/pricing?set-cookie=${probe}`,
		{ method: 'GET' },
	)
	const edgeCache = (caches as CacheStorage & { default: Cache }).default
	await edgeCache.put(setCookieKey, setCookieResponse.clone()).catch(() => {
		// Cache API rejects Set-Cookie bodies; either path must not store.
	})
	expect(await edgeCache.match(setCookieKey)).toBeUndefined()
})

test('anonymous llms.txt and auth pages are stored in caches.default; cookies stay private', async () => {
	const probe = crypto.randomUUID()
	const llmsPaths = ['/llms.txt', '/docs/llms.txt'] as const
	for (const pathname of llmsPaths) {
		const url = `https://test.kody.dev${pathname}?edge-cache=${probe}`
		const miss = await workerFetch(new Request(url))
		expect(miss.status).toBe(200)
		expect(miss.headers.get('Content-Type')).toMatch(/text\/plain/i)
		expect(miss.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
		expect(miss.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
		const missBody = await miss.text()
		expect(missBody.startsWith('# Kody')).toBe(true)

		const hit = await workerFetch(new Request(url))
		expect(hit.status).toBe(200)
		expect(hit.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
		expect(hit.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
		expect(hit.headers.get('Vary')?.toLowerCase()).toContain('cookie')
		await expect(hit.text()).resolves.toBe(missBody)
	}

	for (const pathname of ['/login', '/signup'] as const) {
		const url = `https://test.kody.dev${pathname}?edge-cache=${probe}`
		const miss = await workerFetch(new Request(url))
		expect(miss.status).toBe(200)
		expect(miss.headers.get('Content-Type')).toMatch(/text\/html/i)
		expect(miss.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
		expect(miss.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
		expect(miss.headers.get('Vary')?.toLowerCase()).toContain('cookie')
		const missHtml = await miss.text()
		expect(missHtml.length).toBeGreaterThan(0)
		expect(missHtml).not.toMatch(/csrf|nonce=/i)

		const hit = await workerFetch(new Request(url))
		expect(hit.status).toBe(200)
		expect(hit.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
		expect(hit.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
		await expect(hit.text()).resolves.toBe(missHtml)

		const withCookie = await workerFetch(
			new Request(url, { headers: { Cookie: 'kody_session=stale' } }),
		)
		expect(withCookie.headers.get(anonymousHtmlEdgeCacheHeader)).not.toBe('HIT')
		expect(withCookie.headers.get('Cache-Control')).toBe('no-store')
		await withCookie.body?.cancel()
	}
})
