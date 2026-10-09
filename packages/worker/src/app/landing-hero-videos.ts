import { cachified } from '@epic-web/cachified'
import { deferWork } from '#worker/deferred-work.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import {
	isLandingHeroVideoList,
	landingHeroSourcePlaylistId,
	type LandingHeroVideo,
} from '#universal/landing-hero-copy.ts'
import {
	parseYoutubePlaylistBrowseJson,
	parseYoutubePlaylistItemsApi,
	uniqueLandingHeroVideos,
	youtubePlaylistBrowseBody,
	youtubePlaylistBrowseMaxPages,
	youtubePlaylistBrowseUrl,
	youtubePlaylistItemsApiUrl,
	youtubePlaylistUserAgent,
} from '#universal/youtube-playlist.ts'

const heroVideosTtlMs = 5 * 60 * 1000
const heroVideosStaleWhileRevalidateMs = 60 * 60 * 1000
const youtubeFetchTimeoutMs = 2_500
export const landingHeroVideosCacheKeyPrefix = 'landing-hero-videos:v5:'

export function buildLandingHeroVideosCacheKey(playlistId: string) {
	return `${landingHeroVideosCacheKeyPrefix}${playlistId}`
}

/**
 * Source playlist videos in playlist order. KV-backed SWR so `/` stays
 * fast when YouTube is slow. Homepage presentation (playlist order,
 * leftover title cleanup) happens at the page boundary via
 * `presentLandingHeroVideos`; this loader stays unfiltered so the
 * youtube-watch allowlist can reuse the cache.
 * Missing key / failed YouTube fail open to `[]`.
 */
export async function loadLandingHeroVideos(input: {
	env: Env
	playlistId?: string
}): Promise<Array<LandingHeroVideo>> {
	const playlistId = input.playlistId ?? landingHeroSourcePlaylistId
	try {
		const kv = input.env.BUNDLE_ARTIFACTS_KV
		if (!kv) {
			return await fetchLandingHeroVideos({
				env: input.env,
				playlistId,
			})
		}
		return await cachified({
			key: buildLandingHeroVideosCacheKey(playlistId),
			cache: createKvCachifiedCache(kv),
			ttl: heroVideosTtlMs,
			staleWhileRevalidate: heroVideosStaleWhileRevalidateMs,
			checkValue: isLandingHeroVideoList,
			getFreshValue: () =>
				fetchLandingHeroVideos({
					env: input.env,
					playlistId,
				}),
			waitUntil(promise) {
				void deferWork('landing-hero-videos-refresh', () => promise)
			},
		})
	} catch (error) {
		console.warn('landing-hero-videos', error)
		return []
	}
}

async function fetchLandingHeroVideos(input: {
	env: Env
	playlistId: string
}): Promise<Array<LandingHeroVideo>> {
	const apiKey = input.env.YOUTUBE_DATA_API_KEY?.trim()
	if (apiKey) {
		const fromApi = await fetchPlaylistItemsApi({
			playlistId: input.playlistId,
			apiKey,
		})
		if (fromApi.length > 0) return fromApi
	}
	return await fetchPlaylistBrowse({
		playlistId: input.playlistId,
	})
}

async function fetchPlaylistItemsApi(input: {
	playlistId: string
	apiKey: string
}): Promise<Array<LandingHeroVideo>> {
	const videos: Array<LandingHeroVideo> = []
	let pageToken: string | undefined
	try {
		for (let page = 0; page < youtubePlaylistBrowseMaxPages; page += 1) {
			// workerd's `fetch` is not a bound function; call the global.
			const response = await fetch(
				youtubePlaylistItemsApiUrl({
					playlistId: input.playlistId,
					apiKey: input.apiKey,
					pageToken,
				}),
				{
					headers: { 'User-Agent': youtubePlaylistUserAgent },
					signal: AbortSignal.timeout(youtubeFetchTimeoutMs),
				},
			)
			if (!response.ok) return uniqueLandingHeroVideos(videos)
			const parsed = parseYoutubePlaylistItemsApi(await response.json())
			videos.push(...parsed.videos)
			if (!parsed.nextPageToken) break
			pageToken = parsed.nextPageToken
		}
		return uniqueLandingHeroVideos(videos)
	} catch {
		return uniqueLandingHeroVideos(videos)
	}
}

async function fetchPlaylistBrowse(input: {
	playlistId: string
}): Promise<Array<LandingHeroVideo>> {
	const videos: Array<LandingHeroVideo> = []
	let continuation: string | undefined
	try {
		for (let page = 0; page < youtubePlaylistBrowseMaxPages; page += 1) {
			// workerd's `fetch` is not a bound function; call the global.
			const response = await fetch(youtubePlaylistBrowseUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': youtubePlaylistUserAgent,
				},
				body: JSON.stringify(
					youtubePlaylistBrowseBody({
						playlistId: input.playlistId,
						continuation,
					}),
				),
				signal: AbortSignal.timeout(youtubeFetchTimeoutMs),
			})
			if (!response.ok) {
				if (videos.length > 0) return uniqueLandingHeroVideos(videos)
				throw new Error(`youtube browse ${String(response.status)}`)
			}
			const parsed = parseYoutubePlaylistBrowseJson(await response.json())
			const before = videos.length
			videos.push(...parsed.videos)
			if (
				!parsed.continuation ||
				parsed.continuation === continuation ||
				videos.length === before
			) {
				break
			}
			continuation = parsed.continuation
		}
		return uniqueLandingHeroVideos(videos)
	} catch (error) {
		if (videos.length > 0) return uniqueLandingHeroVideos(videos)
		throw error
	}
}
