import { expect, test } from 'vitest'
import { createMemoryKv } from '#worker/test-support/auth-provider-harness.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	landingHeroSourcePlaylistId,
	type LandingHeroVideo,
} from '#universal/landing-hero-copy.ts'
import {
	youtubePlaylistBrowseUrl,
	youtubePlaylistItemsApiOrigin,
} from '#universal/youtube-playlist.ts'
import {
	buildLandingHeroVideosCacheKey,
	loadLandingHeroVideos,
} from './landing-hero-videos.ts'

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
	const fetchImpl = async (input: string, init?: RequestInit) => {
		fetches += 1
		expect(input).toBe(youtubePlaylistBrowseUrl)
		expect(init?.method).toBe('POST')
		expect(init?.headers).toMatchObject({
			'User-Agent': 'kody-agent/1.0',
		})
		return Response.json(browsePayload([first, second]))
	}
	const env = { BUNDLE_ARTIFACTS_KV: createMemoryKv() } as Env
	const loaded = await loadLandingHeroVideos({ env, fetchImpl })
	expect(loaded).toEqual([first, second])
	const cached = await loadLandingHeroVideos({ env, fetchImpl })
	expect(cached).toEqual([first, second])
	expect(fetches).toBe(1)
	expect(buildLandingHeroVideosCacheKey(landingHeroSourcePlaylistId)).toBe(
		`landing-hero-videos:v3:${landingHeroSourcePlaylistId}`,
	)
})

test('loadLandingHeroVideos prefers the Data API when a key is set', async () => {
	const urls: Array<string> = []
	const fetchImpl = async (input: string) => {
		urls.push(input)
		return Response.json({
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
	}
	const loaded = await loadLandingHeroVideos({
		env: { YOUTUBE_DATA_API_KEY: 'test-youtube-key' } as Env,
		fetchImpl,
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
	const fetchImpl = async (input: string) => {
		if (input.startsWith(youtubePlaylistItemsApiOrigin)) {
			return new Response('quota', { status: 403 })
		}
		return Response.json(browsePayload([second, first]))
	}
	const loaded = await loadLandingHeroVideos({
		env: { YOUTUBE_DATA_API_KEY: 'bad-key' } as Env,
		fetchImpl,
	})
	expect(loaded).toEqual([second, first])
})

test('loadLandingHeroVideos fails open when YouTube is unreachable', async () => {
	consoleWarn.mockImplementation(() => {})
	await expect(
		loadLandingHeroVideos({
			env: {} as Env,
			fetchImpl: async () => {
				throw new Error('network down')
			},
		}),
	).resolves.toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'landing-hero-videos',
		expect.any(Error),
	)
})

test('loadLandingHeroVideos stays offline in unit tests without a fetch impl', async () => {
	await expect(loadLandingHeroVideos({ env: {} as Env })).resolves.toEqual([])
})

test('loadLandingHeroVideos does not cache a failed YouTube fetch', async () => {
	consoleWarn.mockImplementation(() => {})
	let fetches = 0
	const fetchImpl = async () => {
		fetches += 1
		return new Response('no', { status: 503 })
	}
	const env = { BUNDLE_ARTIFACTS_KV: createMemoryKv() } as Env
	await expect(loadLandingHeroVideos({ env, fetchImpl })).resolves.toEqual([])
	await expect(loadLandingHeroVideos({ env, fetchImpl })).resolves.toEqual([])
	expect(fetches).toBe(2)
})
