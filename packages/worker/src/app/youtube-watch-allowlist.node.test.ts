import { expect, test } from 'vitest'
import { youtubeWatchSampleVideoId } from '#universal/youtube-watch.ts'
import {
	loadPlaylistVideoIds,
	resolveYoutubeWatchAllowedVideoIds,
} from './youtube-watch-allowlist.ts'

const videoId = youtubeWatchSampleVideoId
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

test('resolveYoutubeWatchAllowedVideoIds uses extra ids when playlists are none', async () => {
	const ids = await resolveYoutubeWatchAllowedVideoIds({
		env: {
			YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
			YOUTUBE_ALLOWED_VIDEO_IDS: videoId,
		} as Env,
		fetchImpl: async () => {
			throw new Error('playlist fetch should not run')
		},
	})
	expect(ids).toEqual([videoId])
})

test('resolveYoutubeWatchAllowedVideoIds always includes the look-preview sample id', async () => {
	const ids = await resolveYoutubeWatchAllowedVideoIds({
		env: {
			YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
		} as Env,
		fetchImpl: async () => {
			throw new Error('playlist fetch should not run')
		},
	})
	expect(ids).toEqual([videoId])
})
