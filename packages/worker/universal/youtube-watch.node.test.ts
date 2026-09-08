import { expect, test } from 'vitest'
import {
	collectYoutubeVideoIdsFromHrefs,
	mergeYoutubeWatchAllowlist,
	parseYoutubePlaylistFeedXml,
	parseYoutubePlaylistIdList,
	parseYoutubeVideoId,
	parseYoutubeVideoIdList,
	parseYoutubeWatchSearch,
	resolveSiteBannerImageUrl,
	rewriteBannerHrefForYoutubeWatch,
	stripYoutubeWatchSearch,
	youtubeNocookieEmbedUrl,
	youtubeThumbPath,
	youtubeThumbnailSourceUrl,
	youtubeWatchHref,
} from './youtube-watch.ts'

const videoId = 'QA0xYMAMjEg'

test('parseYoutubeVideoId accepts watch, short, embed, thumb, and raw ids', () => {
	expect(parseYoutubeVideoId(videoId)).toBe(videoId)
	expect(
		parseYoutubeVideoId(
			`https://www.youtube.com/watch?v=${videoId}&list=PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY`,
		),
	).toBe(videoId)
	expect(parseYoutubeVideoId(`https://youtu.be/${videoId}`)).toBe(videoId)
	expect(parseYoutubeVideoId(`https://www.youtube.com/embed/${videoId}`)).toBe(
		videoId,
	)
	expect(
		parseYoutubeVideoId(
			`https://www.youtube-nocookie.com/embed/${videoId}?rel=0`,
		),
	).toBe(videoId)
	expect(parseYoutubeVideoId(`https://www.youtube.com/shorts/${videoId}`)).toBe(
		videoId,
	)
	expect(parseYoutubeVideoId(`/?youtubeId=${videoId}`)).toBe(videoId)
	expect(parseYoutubeVideoId(`/blog?youtubeId=${videoId}`)).toBe(videoId)
	expect(parseYoutubeVideoId(youtubeThumbPath(videoId))).toBe(videoId)
	expect(
		parseYoutubeVideoId(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`),
	).toBe(videoId)
	expect(parseYoutubeVideoId('https://example.com/watch?v=nope')).toBeNull()
	expect(parseYoutubeVideoId('not-a-video-id')).toBeNull()
})

test('parseYoutubeVideoId ignores video ids on non-YouTube hosts', () => {
	expect(
		parseYoutubeVideoId(`https://example.test/?video=${videoId}`),
	).toBeNull()
	expect(
		parseYoutubeVideoId(`https://example.test/?youtubeId=${videoId}`),
	).toBeNull()
	expect(
		parseYoutubeVideoId(`https://notyoutube.com/watch?v=${videoId}`),
	).toBeNull()
	expect(
		parseYoutubeVideoId(`https://kody.codes/?youtubeId=${videoId}`),
	).toBeNull()
	expect(parseYoutubeVideoId(`/?video=${videoId}`)).toBeNull()
})

test('watch search helpers read and strip only the youtubeId param', () => {
	expect(parseYoutubeWatchSearch(`?youtubeId=${videoId}&utm=1`)).toBe(videoId)
	expect(parseYoutubeWatchSearch('?utm=1')).toBeNull()
	expect(parseYoutubeWatchSearch(`?video=${videoId}`)).toBeNull()
	expect(stripYoutubeWatchSearch('/', `?youtubeId=${videoId}&utm=1`)).toBe(
		'/?utm=1',
	)
	expect(stripYoutubeWatchSearch('/blog', `?youtubeId=${videoId}`)).toBe(
		'/blog',
	)
})

test('playlist and extra-id lists ignore junk and treat none as empty', () => {
	expect(parseYoutubePlaylistIdList(undefined)).toEqual([])
	expect(parseYoutubePlaylistIdList('none')).toEqual([])
	expect(
		parseYoutubePlaylistIdList(
			'PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY, not-a-list, PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY',
		),
	).toEqual(['PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY'])
	expect(parseYoutubeVideoIdList(`${videoId}, nope, ${videoId}`)).toEqual([
		videoId,
	])
})

test('playlist Atom feed parser reads yt:videoId entries', () => {
	expect(
		parseYoutubePlaylistFeedXml(
			`<feed><entry><yt:videoId>${videoId}</yt:videoId></entry><entry><yt:videoId>abcdefghijk</yt:videoId></entry></feed>`,
		),
	).toEqual([videoId, 'abcdefghijk'])
})

test('allowlist merge includes playlist, extra ids, and banner hrefs', () => {
	expect(
		mergeYoutubeWatchAllowlist({
			playlistVideoIds: [videoId],
			extraVideoIds: ['dQw4w9wgvcQ'],
			hrefs: [
				youtubeWatchHref('oHg5SJYRHA0'),
				`https://youtu.be/${videoId}`,
				null,
			],
		}),
	).toEqual([videoId, 'dQw4w9wgvcQ', 'oHg5SJYRHA0'])
	expect(
		collectYoutubeVideoIdsFromHrefs([youtubeThumbPath(videoId), '/pricing']),
	).toEqual([videoId])
})

test('banner hrefs and images rewrite YouTube hosts to first-party watch/thumb paths', () => {
	expect(
		rewriteBannerHrefForYoutubeWatch(
			`https://www.youtube.com/watch?v=${videoId}`,
		),
	).toBe(`/?youtubeId=${videoId}`)
	expect(rewriteBannerHrefForYoutubeWatch('/blog?youtubeId=abc')).toBe(
		'/blog?youtubeId=abc',
	)
	expect(
		rewriteBannerHrefForYoutubeWatch(`https://example.test/?video=${videoId}`),
	).toBe(`https://example.test/?video=${videoId}`)
	expect(rewriteBannerHrefForYoutubeWatch('/pricing')).toBe('/pricing')
	expect(
		resolveSiteBannerImageUrl({
			imageUrl: null,
			ctaHref: youtubeWatchHref(videoId),
			secondaryHref: null,
		}),
	).toBe(`/youtube-thumb/${videoId}`)
	expect(
		resolveSiteBannerImageUrl({
			imageUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
			ctaHref: null,
			secondaryHref: null,
		}),
	).toBe(`/youtube-thumb/${videoId}`)
	expect(
		resolveSiteBannerImageUrl({
			imageUrl: '/brand/launch.png',
			ctaHref: youtubeWatchHref(videoId),
			secondaryHref: null,
		}),
	).toBe('/brand/launch.png')
	expect(youtubeThumbnailSourceUrl(videoId)).toBe(
		`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
	)
	expect(youtubeNocookieEmbedUrl(videoId)).toBe(
		`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`,
	)
})
