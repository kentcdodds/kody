import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	anonymousHtmlCacheControl,
	anonymousVisibilityGatedCacheControl,
} from '#app/anonymous-html-cache.ts'
import {
	anonymousHtmlEdgeCacheHeader,
	isAnonymousHtmlCacheStoreable,
} from '#app/anonymous-html-edge-cache.ts'
import { firstPartySecurityHeaders } from '#worker/app/security-headers.ts'

async function workerFetch(request: Request): Promise<Response> {
	const ctx = createExecutionContext()
	const response = await exports.default.fetch(request, env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

function expectSecurityHeaders(response: Response) {
	for (const [name, value] of Object.entries(firstPartySecurityHeaders)) {
		expect(response.headers.get(name)).toBe(value)
	}
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
	expectSecurityHeaders(miss)
	const missHtml = await miss.text()
	expect(missHtml.length).toBeGreaterThan(0)

	const hit = await workerFetch(new Request(pricingUrl))
	expect(hit.status).toBe(200)
	expect(hit.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
	expect(hit.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
	expectSecurityHeaders(hit)
	await expect(hit.text()).resolves.toBe(missHtml)

	const session = await workerFetch(
		new Request(pricingUrl, {
			headers: { Cookie: 'kody_session=stale' },
		}),
	)
	expect(session.headers.get(anonymousHtmlEdgeCacheHeader)).not.toBe('HIT')
	expect(session.headers.get('Cache-Control')).toBe('no-store')

	const authorized = await workerFetch(
		new Request(pricingUrl, {
			headers: { Authorization: 'Bearer not-a-token' },
		}),
	)
	expect(authorized.headers.get(anonymousHtmlEdgeCacheHeader)).not.toBe('HIT')

	const bypass = await workerFetch(
		new Request(pricingUrl, {
			headers: { 'Cache-Control': 'no-cache' },
		}),
	)
	expect(bypass.headers.get(anonymousHtmlEdgeCacheHeader)).not.toBe('HIT')

	const missing = await workerFetch(new Request(missingGuideUrl))
	expect(missing.status).toBe(404)
	expect(missing.headers.get(anonymousHtmlEdgeCacheHeader)).not.toBe('HIT')
	const missingAgain = await workerFetch(new Request(missingGuideUrl))
	expect(missingAgain.status).toBe(404)
	expect(missingAgain.headers.get(anonymousHtmlEdgeCacheHeader)).not.toBe('HIT')

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
	await caches.default
		.put(setCookieKey, setCookieResponse.clone())
		.catch(() => {
			// Cache API rejects Set-Cookie bodies; either path must not store.
		})
	expect(await caches.default.match(setCookieKey)).toBeUndefined()

	const notOk = new Response('<html>nope</html>', {
		status: 500,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': anonymousVisibilityGatedCacheControl,
		},
	})
	expect(isAnonymousHtmlCacheStoreable(notOk)).toBe(false)
	const notOkKey = new Request(
		`https://test.kody.dev/pricing?not-ok=${probe}`,
		{ method: 'GET' },
	)
	if (isAnonymousHtmlCacheStoreable(notOk)) {
		await caches.default.put(notOkKey, notOk.clone())
	}
	expect(await caches.default.match(notOkKey)).toBeUndefined()
})
