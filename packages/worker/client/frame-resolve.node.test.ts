import { expect, test, vi } from 'vitest'
import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'
import {
	assertRenderableFrameResponse,
	createFrameResolveInit,
	fetchFrameResolve,
	rejectCachedDocumentFrameResponse,
	resolveClientFrame,
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
	expect(getInit.cache).toBe('no-store')
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

test('fetchFrameResolve misses the cached document URL', async () => {
	const ok = new Response('<head></head><div>listings</div>', { status: 200 })
	const fetchMock = vi.fn().mockResolvedValue(ok)
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await fetchFrameResolve('/community?sort=newest', {
				target: 'community-listings',
			}),
		).toBe(ok)
		expect(fetchMock).toHaveBeenCalledWith(
			'/community?sort=newest&__frame=community-listings',
			expect.objectContaining({ cache: 'no-store' }),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('rejectCachedDocumentFrameResponse refuses a nested document', async () => {
	const fragment = new Response('<head></head><div>listings</div>', {
		headers: { 'Content-Type': 'text/html' },
	})
	expect(await rejectCachedDocumentFrameResponse(fragment, '/community')).toBe(
		fragment,
	)

	const document = new Response(
		'<!DOCTYPE html><html><body>page</body></html>',
		{
			headers: { 'Content-Type': 'text/html' },
		},
	)
	// Target-less soft navigation reloads the top frame. The document is the page.
	expect(
		await rejectCachedDocumentFrameResponse(document, 'https://kody.codes/'),
	).toBe(document)
	await expect(
		rejectCachedDocumentFrameResponse(
			document,
			'/community',
			'community-listings',
		),
	).rejects.toThrow(
		'Frame resolve received a cached document for /community target=community-listings',
	)
})

test('resolveClientFrame accepts a document without a frame target and rejects one for a named frame', async () => {
	const documentHtml = '<!DOCTYPE html><html><body>page</body></html>'
	const fragmentHtml = '<head></head><div>listings</div>'
	const htmlResponse = (body: string, status = 200) =>
		new Response(body, {
			status,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		})
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	const miss = () => undefined
	try {
		fetchMock.mockResolvedValueOnce(htmlResponse(documentHtml))
		const home = await resolveClientFrame(
			'https://kody.codes/',
			undefined,
			miss,
		)
		expect(await home.text()).toBe(documentHtml)
		expect(fetchMock).toHaveBeenCalledWith(
			'https://kody.codes/',
			expect.objectContaining({ cache: 'no-store' }),
		)

		fetchMock.mockResolvedValueOnce(htmlResponse(documentHtml))
		const community = await resolveClientFrame('/community', {}, miss)
		expect(await community.text()).toBe(documentHtml)
		expect(fetchMock).toHaveBeenLastCalledWith(
			'/community',
			expect.objectContaining({ cache: 'no-store' }),
		)

		const cachedDocument = await resolveClientFrame(
			'/',
			undefined,
			() => documentHtml,
		)
		expect(await cachedDocument.text()).toBe(documentHtml)

		await expect(
			resolveClientFrame(
				'/community',
				{ target: 'community-listings' },
				() => documentHtml,
			),
		).rejects.toThrow(
			'Frame resolve received a cached document for /community target=community-listings',
		)

		fetchMock.mockResolvedValueOnce(htmlResponse(documentHtml))
		await expect(
			resolveClientFrame('/community', { target: 'community-listings' }, miss),
		).rejects.toThrow(
			'Frame resolve received a cached document for /community target=community-listings',
		)
		expect(fetchMock).toHaveBeenLastCalledWith(
			'/community?__frame=community-listings',
			expect.objectContaining({ cache: 'no-store' }),
		)
		const namedInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
		expect((namedInit.headers as Headers).get(REMIX_FRAME_TARGET_HEADER)).toBe(
			'community-listings',
		)

		fetchMock.mockResolvedValueOnce(htmlResponse(fragmentHtml))
		const listings = await resolveClientFrame(
			'/community?sort=newest',
			{ target: 'community-listings' },
			miss,
		)
		expect(await listings.text()).toBe(fragmentHtml)
		expect(fetchMock).toHaveBeenLastCalledWith(
			'/community?sort=newest&__frame=community-listings',
			expect.objectContaining({ cache: 'no-store' }),
		)

		const cachedFragment = await resolveClientFrame(
			'/community',
			{ target: 'community-listings' },
			() => fragmentHtml,
		)
		expect(await cachedFragment.text()).toBe(fragmentHtml)

		fetchMock.mockResolvedValueOnce(htmlResponse(documentHtml, 500))
		await expect(
			resolveClientFrame('https://kody.codes/', undefined, miss),
		).rejects.toThrow('Frame resolve failed (500) for https://kody.codes/')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('fetchFrameResolve retries once on GET network TypeErrors only', async () => {
	const ok = new Response('<html></html>', { status: 200 })
	const getRetry = vi
		.fn()
		.mockRejectedValueOnce(new TypeError('Load failed'))
		.mockResolvedValueOnce(ok)
	vi.stubGlobal('fetch', getRetry)
	try {
		expect(
			await fetchFrameResolve('/community', { target: 'community-listings' }),
		).toBe(ok)
		expect(getRetry).toHaveBeenCalledTimes(2)
		const frameUrl = '/community?__frame=community-listings'
		expect(getRetry).toHaveBeenNthCalledWith(
			1,
			frameUrl,
			expect.objectContaining({ cache: 'no-store' }),
		)
		expect(getRetry).toHaveBeenNthCalledWith(
			2,
			frameUrl,
			expect.objectContaining({ cache: 'no-store' }),
		)
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
