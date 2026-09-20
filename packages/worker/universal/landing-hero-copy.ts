import { landingHeroHeadline } from '#universal/landing-home-copy.ts'
import { isYoutubeVideoId } from '#universal/youtube-watch.ts'

export type LandingHeroVideo = {
	videoId: string
	title: string
}

const retiredHeroTitlePattern = /stop sweating/i

/**
 * Homepage-only presentation: keep playlist order, drop invalid clips,
 * and retitle leftover "Stop Sweating" strings to the locked continuity H1.
 */
export function presentLandingHeroVideos(
	videos: ReadonlyArray<LandingHeroVideo>,
): Array<LandingHeroVideo> {
	const result: Array<LandingHeroVideo> = []
	for (const video of videos) {
		if (!isLandingHeroVideo(video)) continue
		result.push({
			videoId: video.videoId,
			title: retiredHeroTitlePattern.test(video.title)
				? landingHeroHeadline
				: video.title.trim(),
		})
	}
	return result
}

/**
 * Unlisted playlist that owns the homepage chooser: order and membership.
 * Kent adds videos by putting them on this playlist; the Worker reads it at
 * request time (KV SWR). The homepage lite player embeds the selected video
 * only, without a playlist id, so YouTube player chrome uses that video's
 * title instead of a catalog first-item title.
 */
export const landingHeroSourcePlaylistId = 'PLBPBUA8boGLA'

/**
 * Public catalog playlist. The homepage lite player does not attach this id.
 */
export const landingHeroDemoPlaylistId = 'PLXa53KPj2nlE'

export const landingHeroChooserLabelLead = 'Watch Some '
export const landingHeroChooserLabelEmphasis = 'Demos'
export const landingHeroChooserLabel = `${landingHeroChooserLabelLead}${landingHeroChooserLabelEmphasis}`

export function isLandingHeroVideo(value: unknown): value is LandingHeroVideo {
	if (typeof value !== 'object' || value === null) return false
	const video = value as Record<string, unknown>
	return (
		typeof video.videoId === 'string' &&
		isYoutubeVideoId(video.videoId) &&
		typeof video.title === 'string' &&
		video.title.trim().length > 0
	)
}

export function isLandingHeroVideoList(
	value: unknown,
): value is Array<LandingHeroVideo> {
	return Array.isArray(value) && value.every(isLandingHeroVideo)
}
