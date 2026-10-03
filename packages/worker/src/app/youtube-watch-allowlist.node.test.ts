import { expect, test } from 'vitest'
import { youtubeWatchSampleVideoId } from '#universal/youtube-watch.ts'
import {
	bundledDocWatchVideoIds,
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

test('resolveYoutubeWatchAllowedVideoIds always includes the sample id and env extras', async () => {
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
	expect(sampleOnly).toContain(videoId)
	const docWatchIds = bundledDocWatchVideoIds()
	expect(docWatchIds.length).toBeGreaterThan(0)
	expect(sampleOnly).toEqual(expect.arrayContaining(docWatchIds))

	const withExtra = await resolveYoutubeWatchAllowedVideoIds({
		env: {
			YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
			YOUTUBE_ALLOWED_VIDEO_IDS: extraVideoId,
		} as Env,
		fetchImpl,
	})
	expect(withExtra).toContain(extraVideoId)
	expect(withExtra).toContain(videoId)
	expect(withExtra).toEqual(expect.arrayContaining(docWatchIds))
	expect(withExtra.indexOf(extraVideoId)).toBeLessThan(
		withExtra.indexOf(videoId),
	)
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
	})
	expect(ids).toContain(videoId)
	expect(ids).toEqual(expect.arrayContaining(bundledDocWatchVideoIds()))
})
