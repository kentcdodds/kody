import { isYoutubeVideoId } from '#universal/youtube-watch.ts'

/**
 * Homepage hero headline. The live H1 and the home OG card both read these
 * parts so a wording change cannot update one surface and miss the other.
 */
export const landingHeroHeadlineLead = 'Stop'
export const landingHeroHeadlineAccent = 'Sweating'
export const landingHeroHeadlineRest = 'Switching Agents'

export const landingHeroHeadline = `${landingHeroHeadlineLead} ${landingHeroHeadlineAccent} ${landingHeroHeadlineRest}`

export const landingHeroCopyPromptLabel = 'Copy the discovery prompt'

export type LandingHeroVideo = {
	videoId: string
	title: string
}

/**
 * Unlisted playlist that owns the homepage chooser: order and membership.
 * Kent adds videos by putting them on this playlist; the Worker reads it at
 * request time (KV SWR). Embeds still use `landingHeroDemoPlaylistId`.
 */
export const landingHeroSourcePlaylistId = 'PLBPBUA8boGLA'

/**
 * Public playlist passed on the lite-player embed so end-of-video
 * recommendations stay in that catalog (more videos than the home chooser).
 */
export const landingHeroDemoPlaylistId = 'PLXa53KPj2nlE'

export const landingHeroChooserLabel = 'More Kody videos'

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
