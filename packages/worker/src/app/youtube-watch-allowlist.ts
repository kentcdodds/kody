import {
	mergeYoutubeWatchAllowlist,
	parseYoutubePlaylistFeedXml,
	parseYoutubePlaylistIdList,
	parseYoutubeVideoIdList,
	youtubePlaylistFeedCacheSeconds,
	youtubePlaylistFeedUrl,
	youtubeWatchSampleVideoId,
} from '#universal/youtube-watch.ts'
import { type SiteBannerRecord } from '#universal/site-banners.ts'
import { listEnabledSiteBanners } from '#worker/site-banners/service.ts'

type YoutubeWatchFetch = (
	input: string,
	init?: { signal?: AbortSignal },
) => Promise<Response>

export type YoutubeWatchBannerHrefs = Pick<
	SiteBannerRecord,
	'ctaHref' | 'secondaryHref' | 'imageUrl'
>

export async function resolveYoutubeWatchAllowedVideoIds(input: {
	env: Env
	fetchImpl?: YoutubeWatchFetch
	cache?: Cache
	/** Reuse the SSR banner list so / does not query `site_banners` twice. */
	listedBanners?:
		| Promise<ReadonlyArray<YoutubeWatchBannerHrefs>>
		| ReadonlyArray<YoutubeWatchBannerHrefs>
	/**
	 * Playlist Atom fetch. Default true for thumbs and `?youtubeId=` SSR.
	 * Plain documents skip it: env extras, the sample id, and banner hrefs
	 * still allow Watch CTAs and look-preview.
	 */
	loadPlaylists?: boolean
}): Promise<Array<string>> {
	const playlistIds = parseYoutubePlaylistIdList(
		input.env.YOUTUBE_ALLOWED_PLAYLIST_IDS,
	)
	const extraVideoIds = parseYoutubeVideoIdList(
		input.env.YOUTUBE_ALLOWED_VIDEO_IDS,
	)
	const loadPlaylists = input.loadPlaylists !== false
	const [playlistVideoIds, hrefs] = await Promise.all([
		loadPlaylists
			? loadPlaylistVideoIds({
					playlistIds,
					fetchImpl: input.fetchImpl ?? fetch,
					cache: input.cache ?? readDefaultCache(),
				})
			: Promise.resolve([]),
		listEnabledBannerWatchHrefs(input.env, input.listedBanners),
	])
	return mergeYoutubeWatchAllowlist({
		playlistVideoIds,
		extraVideoIds: [...extraVideoIds, youtubeWatchSampleVideoId],
		hrefs,
	})
}

export async function loadPlaylistVideoIds(input: {
	playlistIds: ReadonlyArray<string>
	fetchImpl: YoutubeWatchFetch
	cache?: Cache
}): Promise<Array<string>> {
	if (input.playlistIds.length === 0) return []
	const nested = await Promise.all(
		input.playlistIds.map((playlistId) =>
			loadOnePlaylistVideoIds({
				playlistId,
				fetchImpl: input.fetchImpl,
				cache: input.cache,
			}),
		),
	)
	return nested.flat()
}

async function loadOnePlaylistVideoIds(input: {
	playlistId: string
	fetchImpl: YoutubeWatchFetch
	cache?: Cache
}): Promise<Array<string>> {
	const cacheRequest = new Request(
		`https://kody.codes/__cache/youtube-playlist/${input.playlistId}`,
	)
	if (input.cache) {
		const cached = await input.cache.match(cacheRequest).catch(() => undefined)
		if (cached) {
			const xml = await cached.text()
			return parseYoutubePlaylistFeedXml(xml)
		}
	}

	try {
		const response = await input.fetchImpl(
			youtubePlaylistFeedUrl(input.playlistId),
			{ signal: AbortSignal.timeout(2_500) },
		)
		if (!response.ok) return []
		const xml = await response.text()
		if (input.cache) {
			await input.cache
				.put(
					cacheRequest,
					new Response(xml, {
						headers: {
							'Cache-Control': `public, max-age=${String(youtubePlaylistFeedCacheSeconds)}`,
							'Content-Type': 'application/atom+xml',
						},
					}),
				)
				.catch(() => undefined)
		}
		return parseYoutubePlaylistFeedXml(xml)
	} catch {
		return []
	}
}

async function listEnabledBannerWatchHrefs(
	env: Env,
	listedBanners?:
		| Promise<ReadonlyArray<YoutubeWatchBannerHrefs>>
		| ReadonlyArray<YoutubeWatchBannerHrefs>,
): Promise<Array<string | null>> {
	if (listedBanners) {
		const banners = await listedBanners
		return bannerWatchHrefs(banners)
	}
	if (typeof env.APP_DB?.prepare !== 'function') return []
	try {
		const banners = await listEnabledSiteBanners(env.APP_DB)
		return bannerWatchHrefs(banners)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (
			message.includes('no such table: site_banners') ||
			message.includes('db.prepare is not a function')
		) {
			return []
		}
		console.error('youtube watch banner href load failed', error)
		return []
	}
}

function bannerWatchHrefs(
	banners: ReadonlyArray<YoutubeWatchBannerHrefs>,
): Array<string | null> {
	return banners.flatMap((banner) => [
		banner.ctaHref,
		banner.secondaryHref,
		banner.imageUrl,
	])
}

function readDefaultCache(): Cache | undefined {
	try {
		if (typeof caches === 'undefined') return undefined
		const store = caches as CacheStorage & { default?: Cache }
		return store.default
	} catch {
		return undefined
	}
}
