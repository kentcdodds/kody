import { expect, test } from 'vitest'
import { RequestContext } from 'remix/router'
import { anonymousHtmlCacheControl } from '#app/anonymous-html-cache.ts'
import { createLandingHeroVideosApiHandler } from './landing-hero-videos.ts'

test('landing hero videos JSON is publicly cacheable and stays offline in unit tests', async () => {
	const response = await createLandingHeroVideosApiHandler({} as Env).handler(
		new RequestContext(
			new Request('https://example.com/landing-hero-videos.json'),
		),
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('cache-control')).toBe(anonymousHtmlCacheControl)
	await expect(response.json()).resolves.toEqual({ ok: true, videos: [] })
})
