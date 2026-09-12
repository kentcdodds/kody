import { expect, test } from 'vitest'
import { youtubeWatchSampleVideoId } from '#universal/youtube-watch.ts'
import {
	loadPlaylistVideoIds,
	resolveYoutubeWatchAllowedVideoIds,
} from './youtube-watch-allowlist.ts'

const videoId = youtubeWatchSampleVideoId
const builtInVideoIds = [videoId]
const playlistId = 'PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY'

test('loadPlaylistVideoIds parses the Atom feed and caches the xml', async () => {
	const store = new Map<string, Response>()
	const cache = {
		async match(request: Request) {
			return store.get(new URL(request.url).pathname)
		},
		async put(request: Request, response: Response) {
			store.set(new URL(request.url).pathname, response)
		},
	} as unknown as Cache
	let fetches = 0
	const fetchImpl = async () => {
		fetches += 1
		return new Response(
			`<feed><entry><yt:videoId>${videoId}</yt:videoId></entry></feed>`,
		)
	}

	const first = await loadPlaylistVideoIds({
		playlistIds: [playlistId],
		fetchImpl,
		cache,
	})
	const second = await loadPlaylistVideoIds({
		playlistIds: [playlistId],
		fetchImpl,
		cache,
	})
	expect(first).toEqual([videoId])
	expect(second).toEqual([videoId])
	expect(fetches).toBe(1)
})

test('loadPlaylistVideoIds fails open when YouTube is unreachable', async () => {
	await expect(
		loadPlaylistVideoIds({
			playlistIds: [playlistId],
			fetchImpl: async () => {
				throw new Error('network down')
			},
		}),
	).resolves.toEqual([])
})

test('resolveYoutubeWatchAllowedVideoIds always includes the look-preview sample id and env extras', async () => {
	const extraVideoId = 'dQw4w9wgvcQ'
	const fetchImpl = async () => {
		throw new Error('playlist fetch should not run')
	}
	const sampleOnly = await resolveYoutubeWatchAllowedVideoIds({
		env: {
			YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
		} as Env,
		fetchImpl,
	})
	expect(sampleOnly).toEqual(builtInVideoIds)

	const withExtra = await resolveYoutubeWatchAllowedVideoIds({
		env: {
			YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
			YOUTUBE_ALLOWED_VIDEO_IDS: extraVideoId,
		} as Env,
		fetchImpl,
	})
	expect(withExtra).toEqual([extraVideoId, ...builtInVideoIds])
})

test('resolveYoutubeWatchAllowedVideoIds skips playlist fetch when loadPlaylists is false', async () => {
	const ids = await resolveYoutubeWatchAllowedVideoIds({
		env: {
			YOUTUBE_ALLOWED_PLAYLIST_IDS: playlistId,
			YOUTUBE_ALLOWED_VIDEO_IDS: videoId,
		} as Env,
		fetchImpl: async () => {
			throw new Error('playlist fetch should not run')
		},
		loadPlaylists: false,
		listedBanners: [
			{
				ctaHref: `/?youtubeId=${videoId}`,
				secondaryHref: null,
				imageUrl: null,
			},
		],
	})
	expect(ids).toEqual(builtInVideoIds)
})

test('resolveYoutubeWatchAllowedVideoIds uses listedBanners instead of querying D1', async () => {
	const bannerVideoId = 'dQw4w9wgvcQ'
	const ids = await resolveYoutubeWatchAllowedVideoIds({
		env: {
			YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
			APP_DB: {
				prepare() {
					throw new Error('site_banners should not be queried')
				},
			},
		} as unknown as Env,
		listedBanners: [
			{
				ctaHref: `/?youtubeId=${bannerVideoId}`,
				secondaryHref: null,
				imageUrl: null,
			},
		],
	})
	expect(ids).toEqual([...builtInVideoIds, bannerVideoId])
})
