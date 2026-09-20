import { landingHeroHeadline } from '#universal/landing-home-copy.ts'
import { isYoutubeVideoId } from '#universal/youtube-watch.ts'

export type LandingHeroVideo = {
	videoId: string
	title: string
}

/**
 * Public thumbs that still paint the retired switching-agents hero
 * ("Stop Sweating Agent Switching" / "Switch Agents"). Keep them off the
 * homepage strip until that artwork changes. HTML titles are not enough:
 * the YouTube poster is the visible text.
 */
export const landingHeroCarouselOmittedVideoIds = [
	'iGMkgjXc8Ho',
	'QA0xYMAMjEg',
] as const

const retiredHeroTitlePattern = /stop sweating/i

/**
 * Homepage-only presentation: drop clips whose thumb still uses the
 * retired hero, and retitle any leftover "Stop Sweating" strings to the
 * locked continuity H1.
 */
export function presentLandingHeroVideos(
	videos: ReadonlyArray<LandingHeroVideo>,
): Array<LandingHeroVideo> {
	const omitted = new Set<string>(landingHeroCarouselOmittedVideoIds)
	const result: Array<LandingHeroVideo> = []
	for (const video of videos) {
		if (!isLandingHeroVideo(video) || omitted.has(video.videoId)) continue
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
 * request time (KV SWR). Embeds still use `landingHeroDemoPlaylistId`.
 */
export const landingHeroSourcePlaylistId = 'PLBPBUA8boGLA'

/**
 * Public playlist passed on the lite-player embed so end-of-video
 * recommendations stay in that catalog (more videos than the home chooser).
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
