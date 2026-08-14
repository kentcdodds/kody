import { expect, test } from 'vitest'
import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'
import {
	createFrameResolveInit,
	prefetchedFrameResponse,
} from './frame-resolve.ts'

test('frame resolve never attaches a body to GET or HEAD, including lowercase methods', async () => {
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

	const cached = prefetchedFrameResponse('<div>listings</div>')
	expect(cached).toBeInstanceOf(Response)
	expect(cached.headers.get('Content-Type')).toContain('text/html')
	expect(await cached.text()).toBe('<div>listings</div>')
})
