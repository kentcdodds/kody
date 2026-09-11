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
} from '#universal/youtube-playlist.ts'

const heroVideosTtlMs = 5 * 60 * 1000
const heroVideosStaleWhileRevalidateMs = 60 * 60 * 1000
const youtubeFetchTimeoutMs = 2_500
export const landingHeroVideosCacheKeyPrefix = 'landing-hero-videos:v1:'

type YoutubeFetch = (input: string, init?: RequestInit) => Promise<Response>

export function buildLandingHeroVideosCacheKey(playlistId: string) {
	return `${landingHeroVideosCacheKeyPrefix}${playlistId}`
}

function isVitestRuntime() {
	const runtimeProcess = (
		globalThis as { process?: { env?: Record<string, unknown> } }
	).process
	return Boolean(runtimeProcess?.env?.VITEST)
}

function shouldFetchYoutubePlaylist(fetchImpl?: YoutubeFetch) {
	return Boolean(fetchImpl) || !isVitestRuntime()
}

/**
 * Homepage chooser videos in playlist order. KV-backed SWR so `/` stays
 * fast when YouTube is slow. Unit tests stay offline unless a fetch impl is
 * passed. Missing key / failed YouTube fail open to `[]`.
 */
export async function loadLandingHeroVideos(input: {
	env: Env
	fetchImpl?: YoutubeFetch
	playlistId?: string
}): Promise<Array<LandingHeroVideo>> {
	const playlistId = input.playlistId ?? landingHeroSourcePlaylistId
	if (!shouldFetchYoutubePlaylist(input.fetchImpl)) return []
	const fetchImpl = input.fetchImpl ?? fetch
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) {
		return await fetchLandingHeroVideos({
			env: input.env,
			playlistId,
			fetchImpl,
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
				fetchImpl,
			}),
		waitUntil(promise) {
			void deferWork('landing-hero-videos-refresh', () => promise)
		},
	})
}

async function fetchLandingHeroVideos(input: {
	env: Env
	playlistId: string
	fetchImpl: YoutubeFetch
}): Promise<Array<LandingHeroVideo>> {
	const apiKey = input.env.YOUTUBE_DATA_API_KEY?.trim()
	if (apiKey) {
		const fromApi = await fetchPlaylistItemsApi({
			playlistId: input.playlistId,
			apiKey,
			fetchImpl: input.fetchImpl,
		})
		if (fromApi.length > 0) return fromApi
	}
	return await fetchPlaylistBrowse({
		playlistId: input.playlistId,
		fetchImpl: input.fetchImpl,
	})
}

async function fetchPlaylistItemsApi(input: {
	playlistId: string
	apiKey: string
	fetchImpl: YoutubeFetch
}): Promise<Array<LandingHeroVideo>> {
	const videos: Array<LandingHeroVideo> = []
	let pageToken: string | undefined
	try {
		for (let page = 0; page < youtubePlaylistBrowseMaxPages; page += 1) {
			const response = await input.fetchImpl(
				youtubePlaylistItemsApiUrl({
					playlistId: input.playlistId,
					apiKey: input.apiKey,
					pageToken,
				}),
				{ signal: AbortSignal.timeout(youtubeFetchTimeoutMs) },
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
	fetchImpl: YoutubeFetch
}): Promise<Array<LandingHeroVideo>> {
	const videos: Array<LandingHeroVideo> = []
	let continuation: string | undefined
	try {
		for (let page = 0; page < youtubePlaylistBrowseMaxPages; page += 1) {
			const response = await input.fetchImpl(youtubePlaylistBrowseUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					youtubePlaylistBrowseBody({
						playlistId: input.playlistId,
						continuation,
					}),
				),
				signal: AbortSignal.timeout(youtubeFetchTimeoutMs),
			})
			if (!response.ok) return uniqueLandingHeroVideos(videos)
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
	} catch {
		return uniqueLandingHeroVideos(videos)
	}
}
