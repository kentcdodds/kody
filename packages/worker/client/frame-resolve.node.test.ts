import { expect, test, vi } from 'vitest'
import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'
import {
	assertRenderableFrameResponse,
	createFrameResolveInit,
	fetchFrameResolve,
} from './frame-resolve.ts'

test('frame resolve never attaches a body to GET or HEAD, including lowercase methods', () => {
	const formData = new FormData()
	formData.set('q', 'remix')

	const getInit = createFrameResolveInit({
		target: 'community-listings',
		method: 'get',
		formData,
		encType: 'application/x-www-form-urlencoded',
	})
	expect(getInit.method).toBe('get')
	expect(getInit.body).toBeUndefined()
	expect((getInit.headers as Headers).get(REMIX_FRAME_TARGET_HEADER)).toBe(
		'community-listings',
	)

	const headInit = createFrameResolveInit({
		method: 'HEAD',
		formData,
	})
	expect(headInit.method).toBe('HEAD')
	expect(headInit.body).toBeUndefined()

	const postInit = createFrameResolveInit({
		method: 'post',
		formData,
		encType: 'application/x-www-form-urlencoded',
	})
	expect(postInit.method).toBe('post')
	expect(postInit.body).toBeInstanceOf(URLSearchParams)
	expect(String(postInit.body)).toBe('q=remix')
})

test('fetchFrameResolve retries once on GET network TypeErrors only', async () => {
	const ok = new Response('<html></html>', { status: 200 })
	const getRetry = vi
		.fn()
		.mockRejectedValueOnce(new TypeError('Load failed'))
		.mockResolvedValueOnce(ok)
	vi.stubGlobal('fetch', getRetry)
	try {
		expect(await fetchFrameResolve('/@kody/planetscale')).toBe(ok)
		expect(getRetry).toHaveBeenCalledTimes(2)
	} finally {
		vi.unstubAllGlobals()
	}

	const chromiumWithOrigin = vi
		.fn()
		.mockRejectedValueOnce(new TypeError('Failed to fetch (kody.codes)'))
		.mockResolvedValueOnce(ok)
	vi.stubGlobal('fetch', chromiumWithOrigin)
	try {
		expect(await fetchFrameResolve('/')).toBe(ok)
		expect(chromiumWithOrigin).toHaveBeenCalledTimes(2)
	} finally {
		vi.unstubAllGlobals()
	}

	const postNoRetry = vi
		.fn()
		.mockRejectedValueOnce(new TypeError('Failed to fetch'))
	vi.stubGlobal('fetch', postNoRetry)
	try {
		await expect(
			fetchFrameResolve('/action', {
				method: 'post',
				formData: new FormData(),
			}),
		).rejects.toThrow('Failed to fetch')
		expect(postNoRetry).toHaveBeenCalledTimes(1)
	} finally {
		vi.unstubAllGlobals()
	}

	const nonNetwork = vi
		.fn()
		.mockRejectedValueOnce(new TypeError('null is not an object'))
	vi.stubGlobal('fetch', nonNetwork)
	try {
		await expect(fetchFrameResolve('/@kody/planetscale')).rejects.toThrow(
			'null is not an object',
		)
		expect(nonNetwork).toHaveBeenCalledTimes(1)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('assertRenderableFrameResponse matches the Remix default resolver', () => {
	const html = { 'Content-Type': 'Text/HTML; charset=utf-8' }
	const src = 'https://kody.codes/account'

	const notFound = new Response('<p>missing</p>', {
		status: 404,
		headers: html,
	})
	expect(assertRenderableFrameResponse(notFound, src)).toBe(notFound)

	const redirect = new Response('<p>moved</p>', { status: 302, headers: html })
	expect(assertRenderableFrameResponse(redirect, src)).toBe(redirect)

	expect(() =>
		assertRenderableFrameResponse(
			new Response('{}', {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			}),
			src,
			'community-listings',
		),
	).toThrow(
		'Frame resolve failed (404) for https://kody.codes/account target=community-listings',
	)

	expect(() =>
		assertRenderableFrameResponse(
			new Response('<p>boom</p>', { status: 500, headers: html }),
			src,
		),
	).toThrow('Frame resolve failed (500) for https://kody.codes/account')
})
