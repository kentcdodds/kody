import { expect, test } from 'vitest'
import { homeRouteLoader } from './home.tsx'
import { isRouteLoaderRedirect } from '#client/route-loader.ts'
import { routes } from '#universal/routes.ts'

test('homeRouteLoader fail-opens when the hero JSON fetch throws and fetches nothing else', async () => {
	const originalFetch = globalThis.fetch
	const requested: Array<string> = []
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const url = String(input)
		requested.push(url)
		if (url === routes.landingHeroVideosApi.href()) {
			return Promise.reject(new TypeError('Failed to fetch'))
		}
		return Promise.resolve(Response.json({ ok: true }))
	}) as typeof fetch

	try {
		const result = await homeRouteLoader(
			new URL('http://localhost/'),
			new AbortController().signal,
		)
		if (isRouteLoaderRedirect(result)) {
			throw new Error('expected home loader data, not a redirect')
		}
		expect(result.landingHeroVideos).toEqual([])
		expect(result.walkthroughHosts).toBeDefined()
		// The homepage renders no onboarding state, so navigation never
		// waits on the onboarding payload.
		expect(result.onboarding).toBeUndefined()
		expect(requested).toEqual([routes.landingHeroVideosApi.href()])
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('homeRouteLoader rethrows when the hero JSON fetch is aborted', async () => {
	const originalFetch = globalThis.fetch
	const controller = new AbortController()
	controller.abort()
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.signal?.aborted) {
			return Promise.reject(new DOMException('Aborted', 'AbortError'))
		}
		return Promise.resolve(Response.json({ ok: true }))
	}) as typeof fetch

	try {
		await expect(
			homeRouteLoader(new URL('http://localhost/'), controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' })
	} finally {
		globalThis.fetch = originalFetch
	}
})
