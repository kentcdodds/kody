import {
	isLandingHeroVideo,
	type LandingHeroVideo,
} from '#universal/landing-hero-copy.ts'
import { isYoutubeVideoId } from '#universal/youtube-watch.ts'

const skippedPlaylistTitles = new Set(['Private video', 'Deleted video'])

export const youtubePlaylistItemsApiOrigin = 'https://www.googleapis.com'
export const youtubePlaylistBrowseUrl =
	'https://www.youtube.com/youtubei/v1/browse'
export const youtubeWebClientName = 'WEB'
export const youtubeWebClientVersion = '2.20260911.01.00'
export const youtubePlaylistBrowseMaxPages = 10
/** workerd sends no User-Agent; YouTube rejects those browse calls. */
export const youtubePlaylistUserAgent = 'kody-agent/1.0'

export function youtubePlaylistBrowseId(playlistId: string) {
	return `VL${playlistId}`
}

export function youtubePlaylistItemsApiUrl(input: {
	playlistId: string
	apiKey: string
	pageToken?: string
}) {
	const params = new URLSearchParams({
		part: 'snippet',
		maxResults: '50',
		playlistId: input.playlistId,
		key: input.apiKey,
	})
	if (input.pageToken) params.set('pageToken', input.pageToken)
	return `${youtubePlaylistItemsApiOrigin}/youtube/v3/playlistItems?${params.toString()}`
}

export function youtubePlaylistBrowseBody(input: {
	playlistId?: string
	continuation?: string
}) {
	const continuation = input.continuation?.trim()
	if (continuation) {
		return {
			context: youtubeWebClientContext(),
			continuation,
		}
	}
	return {
		context: youtubeWebClientContext(),
		browseId: youtubePlaylistBrowseId(input.playlistId ?? ''),
	}
}

function youtubeWebClientContext() {
	return {
		client: {
			clientName: youtubeWebClientName,
			clientVersion: youtubeWebClientVersion,
		},
	}
}

export function parseYoutubePlaylistItemsApi(payload: unknown): {
	videos: Array<LandingHeroVideo>
	nextPageToken: string | null
} {
	if (typeof payload !== 'object' || payload === null) {
		return { videos: [], nextPageToken: null }
	}
	const body = payload as {
		items?: unknown
		nextPageToken?: unknown
	}
	const videos: Array<LandingHeroVideo> = []
	if (Array.isArray(body.items)) {
		for (const item of body.items) {
			const video = readPlaylistItemsApiVideo(item)
			if (video) videos.push(video)
		}
	}
	const nextPageToken =
		typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0
			? body.nextPageToken
			: null
	return { videos, nextPageToken }
}

export function parseYoutubePlaylistBrowseJson(payload: unknown): {
	videos: Array<LandingHeroVideo>
	continuation: string | null
} {
	if (typeof payload !== 'object' || payload === null) {
		return { videos: [], continuation: null }
	}
	const contents = (payload as { contents?: unknown }).contents
	return {
		videos: collectBrowseVideos(contents),
		continuation: readContinuationToken(contents),
	}
}

function readPlaylistItemsApiVideo(item: unknown): LandingHeroVideo | null {
	if (typeof item !== 'object' || item === null) return null
	const snippet = (item as { snippet?: unknown }).snippet
	if (typeof snippet !== 'object' || snippet === null) return null
	const title = readTitle((snippet as { title?: unknown }).title)
	const resourceId = (snippet as { resourceId?: unknown }).resourceId
	if (typeof resourceId !== 'object' || resourceId === null) return null
	const videoId = (resourceId as { videoId?: unknown }).videoId
	if (typeof videoId !== 'string' || !isYoutubeVideoId(videoId) || !title) {
		return null
	}
	return { videoId, title }
}

function collectBrowseVideos(node: unknown): Array<LandingHeroVideo> {
	const videos: Array<LandingHeroVideo> = []
	const seen = new Set<string>()
	walk(node, (value) => {
		const video = readLockupVideo(value) ?? readPlaylistVideoRenderer(value)
		if (!video || seen.has(video.videoId)) return
		seen.add(video.videoId)
		videos.push(video)
	})
	return videos
}

function readLockupVideo(node: unknown): LandingHeroVideo | null {
	if (typeof node !== 'object' || node === null) return null
	const lockup = (node as { lockupViewModel?: unknown }).lockupViewModel
	if (typeof lockup !== 'object' || lockup === null) return null
	const contentId = (lockup as { contentId?: unknown }).contentId
	const contentType = (lockup as { contentType?: unknown }).contentType
	if (contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null
	if (typeof contentId !== 'string' || !isYoutubeVideoId(contentId)) {
		return null
	}
	const metadata = (lockup as { metadata?: unknown }).metadata
	const title = readLockupTitle(metadata)
	if (!title) return null
	return { videoId: contentId, title }
}

function readPlaylistVideoRenderer(node: unknown): LandingHeroVideo | null {
	if (typeof node !== 'object' || node === null) return null
	const renderer = (node as { playlistVideoRenderer?: unknown })
		.playlistVideoRenderer
	if (typeof renderer !== 'object' || renderer === null) return null
	const videoId = (renderer as { videoId?: unknown }).videoId
	const title = readTitleRuns((renderer as { title?: unknown }).title)
	if (typeof videoId !== 'string' || !isYoutubeVideoId(videoId) || !title) {
		return null
	}
	return { videoId, title }
}

function readLockupTitle(metadata: unknown): string | null {
	if (typeof metadata !== 'object' || metadata === null) return null
	const viewModel = (metadata as { lockupMetadataViewModel?: unknown })
		.lockupMetadataViewModel
	if (typeof viewModel !== 'object' || viewModel === null) return null
	const title = (viewModel as { title?: unknown }).title
	if (typeof title !== 'object' || title === null) return null
	return readTitle((title as { content?: unknown }).content)
}

function readTitleRuns(title: unknown): string | null {
	if (typeof title === 'string') return readTitle(title)
	if (typeof title !== 'object' || title === null) return null
	const simple = readTitle((title as { simpleText?: unknown }).simpleText)
	if (simple) return simple
	const runs = (title as { runs?: unknown }).runs
	if (!Array.isArray(runs)) return null
	const parts: Array<string> = []
	for (const run of runs) {
		if (typeof run !== 'object' || run === null) continue
		const text = (run as { text?: unknown }).text
		if (typeof text === 'string' && text.length > 0) parts.push(text)
	}
	return readTitle(parts.join(''))
}

function readTitle(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const title = value.trim()
	if (!title || skippedPlaylistTitles.has(title)) return null
	return title
}

function readContinuationToken(node: unknown): string | null {
	let token: string | null = null
	walk(node, (value) => {
		if (token || typeof value !== 'object' || value === null) return
		const command = (value as { continuationCommand?: unknown })
			.continuationCommand
		if (typeof command !== 'object' || command === null) return
		const next = (command as { token?: unknown }).token
		if (typeof next === 'string' && next.length > 0) token = next
	})
	return token
}

function walk(node: unknown, visit: (value: unknown) => void) {
	visit(node)
	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit)
		return
	}
	if (typeof node !== 'object' || node === null) return
	for (const value of Object.values(node)) walk(value, visit)
}

export function uniqueLandingHeroVideos(
	videos: ReadonlyArray<LandingHeroVideo>,
): Array<LandingHeroVideo> {
	const seen = new Set<string>()
	const result: Array<LandingHeroVideo> = []
	for (const video of videos) {
		if (!isLandingHeroVideo(video) || seen.has(video.videoId)) continue
		seen.add(video.videoId)
		result.push({ videoId: video.videoId, title: video.title.trim() })
	}
	return result
}
