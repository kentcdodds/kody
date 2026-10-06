import { expect, test, vi } from 'vitest'
import { createLandingHeroVideosApiHandler } from './landing-hero-videos.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

test('landing hero videos JSON is publicly cacheable and stays offline in unit tests', async () => {
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('offline'))
	const response = await createLandingHeroVideosApiHandler({} as Env).handler()
	expect(response.status).toBe(200)
	expect(response.headers.get('cache-control')).toBe(
		'public, max-age=60, stale-while-revalidate=300',
	)
	await expect(response.json()).resolves.toEqual({ ok: true, videos: [] })
	fetchMock.mockRestore()
})
