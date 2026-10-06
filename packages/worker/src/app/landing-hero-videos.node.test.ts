import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { type LandingHeroVideo } from '#universal/landing-hero-copy.ts'
import {
	youtubePlaylistBrowseUrl,
	youtubePlaylistItemsApiOrigin,
} from '#universal/youtube-playlist.ts'
import { loadLandingHeroVideos } from './landing-hero-videos.ts'

const first: LandingHeroVideo = {
	videoId: 'iGMkgjXc8Ho',
	title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
}
const second: LandingHeroVideo = {
	videoId: 'QA0xYMAMjEg',
	title: 'Introducing Kody: Your Personal Software Factory',
}

function browsePayload(videos: ReadonlyArray<LandingHeroVideo>) {
	return {
		contents: {
			itemSectionRenderer: {
				contents: videos.map((video) => ({
					lockupViewModel: {
						contentId: video.videoId,
						contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
						metadata: {
							lockupMetadataViewModel: {
								title: { content: video.title },
							},
						},
					},
				})),
			},
		},
	}
}

test('loadLandingHeroVideos reads Innertube browse order and serves SWR from KV', async () => {
	let fetches = 0
	using _server = createMswNodeServer([
		http.post(youtubePlaylistBrowseUrl, ({ request }) => {
			fetches += 1
			expect(request.headers.get('User-Agent')).toBe('kody-agent/1.0')
			return HttpResponse.json(browsePayload([first, second]))
		}),
	])
	const env = { BUNDLE_ARTIFACTS_KV: createMemoryKv() } as Env
	const loaded = await loadLandingHeroVideos({ env })
	expect(loaded).toEqual([first, second])
	const cached = await loadLandingHeroVideos({ env })
	expect(cached).toEqual([first, second])
	expect(fetches).toBe(1)
})

test('loadLandingHeroVideos prefers the Data API when a key is set', async () => {
	const urls: Array<string> = []
	using _server = createMswNodeServer([
		http.get(
			`${youtubePlaylistItemsApiOrigin}/youtube/v3/playlistItems`,
			({ request }) => {
				urls.push(request.url)
				return HttpResponse.json({
					items: [
						{
							snippet: {
								title: first.title,
								resourceId: { videoId: first.videoId },
							},
						},
						{
							snippet: {
								title: second.title,
								resourceId: { videoId: second.videoId },
							},
						},
					],
				})
			},
		),
	])
	const loaded = await loadLandingHeroVideos({
		env: { YOUTUBE_DATA_API_KEY: 'test-youtube-key' } as Env,
	})
	expect(loaded).toEqual([first, second])
	expect(urls).toHaveLength(1)
	expect(
		urls[0]?.startsWith(`${youtubePlaylistItemsApiOrigin}/youtube/v3/`),
	).toBe(true)
	expect(urls[0]).toContain('playlistId=PLBPBUA8boGLA')
	expect(urls[0]).not.toContain('browse')
})

test('loadLandingHeroVideos falls back to Innertube when the Data API fails', async () => {
	using _server = createMswNodeServer([
		http.get(
			`${youtubePlaylistItemsApiOrigin}/youtube/v3/playlistItems`,
			() => new HttpResponse('quota', { status: 403 }),
		),
		http.post(youtubePlaylistBrowseUrl, () =>
			HttpResponse.json(browsePayload([second, first])),
		),
	])
	const loaded = await loadLandingHeroVideos({
		env: { YOUTUBE_DATA_API_KEY: 'bad-key' } as Env,
	})
	expect(loaded).toEqual([second, first])
})

test('loadLandingHeroVideos fails open offline or on YouTube errors and does not cache the failure', async () => {
	consoleWarn.mockImplementation(() => {})
	{
		using _offlineServer = createMswNodeServer([
			http.post(youtubePlaylistBrowseUrl, () => HttpResponse.error()),
		])
		await expect(loadLandingHeroVideos({ env: {} as Env })).resolves.toEqual([])
	}
	expect(consoleWarn).toHaveBeenCalledWith(
		'landing-hero-videos',
		expect.any(Error),
	)

	let fetches = 0
	using _unavailableServer = createMswNodeServer([
		http.post(youtubePlaylistBrowseUrl, () => {
			fetches += 1
			return new HttpResponse('no', { status: 503 })
		}),
	])
	const env = { BUNDLE_ARTIFACTS_KV: createMemoryKv() } as Env
	await expect(loadLandingHeroVideos({ env })).resolves.toEqual([])
	await expect(loadLandingHeroVideos({ env })).resolves.toEqual([])
	expect(fetches).toBe(2)
})
