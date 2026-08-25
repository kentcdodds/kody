import { expect, test, vi } from 'vitest'
import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'
import { createFrameResolveInit, fetchFrameResolve } from './frame-resolve.ts'

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
