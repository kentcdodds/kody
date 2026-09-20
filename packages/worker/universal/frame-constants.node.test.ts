import { expect, test } from 'vitest'
import {
	frameFetchUrl,
	isFullHtmlDocumentPrefix,
	REMIX_FRAME_TARGET_HEADER,
	requestBypassesAnonymousDocumentCache,
	requestFrameTarget,
} from '#universal/frame-constants.ts'

test('frame fetches differ from the cached document URL', () => {
	expect(frameFetchUrl('/community', 'community-listings')).toBe(
		'/community?__frame=community-listings',
	)
	expect(frameFetchUrl('/community?sort=newest', 'community-listings')).toBe(
		'/community?sort=newest&__frame=community-listings',
	)
	expect(frameFetchUrl('/community', undefined)).toBe('/community')
	expect(
		frameFetchUrl(
			'https://kody.codes/community#packages',
			'community-listings',
		),
	).toBe('https://kody.codes/community?__frame=community-listings#packages')
})

test('frame target comes from the header, then the cache-bust param', () => {
	expect(
		requestFrameTarget(
			new Request('https://kody.codes/community', {
				headers: { [REMIX_FRAME_TARGET_HEADER]: 'community-listings' },
			}),
		),
	).toBe('community-listings')
	expect(
		requestFrameTarget(
			new Request('https://kody.codes/community?__frame=community-listings'),
		),
	).toBe('community-listings')
	expect(
		requestFrameTarget(
			new Request('https://kody.codes/community?__frame=', {
				headers: { [REMIX_FRAME_TARGET_HEADER]: '  community-detail  ' },
			}),
		),
	).toBe('community-detail')
	expect(
		requestFrameTarget(new Request('https://kody.codes/community')),
	).toBeNull()
	expect(
		requestFrameTarget(new Request('https://kody.codes/community?__frame=')),
	).toBeNull()
})

test('frame requests skip the anonymous document cache', () => {
	expect(
		requestBypassesAnonymousDocumentCache(
			new Request('https://kody.codes/community', {
				headers: { [REMIX_FRAME_TARGET_HEADER]: 'community-listings' },
			}),
		),
	).toBe(true)
	expect(
		requestBypassesAnonymousDocumentCache(
			new Request('https://kody.codes/community?__frame=community-listings'),
		),
	).toBe(true)
	expect(
		requestBypassesAnonymousDocumentCache(
			new Request('https://kody.codes/community'),
		),
	).toBe(false)
})

test('only a document prefix is a nested shell', () => {
	expect(isFullHtmlDocumentPrefix('<!DOCTYPE html><html lang="en">')).toBe(true)
	expect(isFullHtmlDocumentPrefix('  <html lang="en">')).toBe(true)
	expect(
		isFullHtmlDocumentPrefix('<head><style></style></head><div></div>'),
	).toBe(false)
})
