/**
 * Homepage hero headline. The live H1 and the home OG card both read these
 * parts so a wording change cannot update one surface and miss the other.
 */
export const landingHeroHeadlineLead = 'Stop'
export const landingHeroHeadlineAccent = 'Sweating'
export const landingHeroHeadlineRest = 'Switching Agents'

export const landingHeroHeadline = `${landingHeroHeadlineLead} ${landingHeroHeadlineAccent} ${landingHeroHeadlineRest}`

export const landingHeroCopyPromptLabel = 'Copy the discovery prompt'

/**
 * Videos offered by the homepage hero, in display order. The first one loads
 * in the lite player; the rest sit in the thumbnail chooser under it. The
 * watch allowlist always includes every id here so the first-party thumb
 * proxy works without extra env. `landingHeroDemoPlaylistId` is passed on the
 * embed so end-of-video recommendations stay in that playlist.
 */
export const landingHeroDemoVideos: ReadonlyArray<{
	videoId: string
	title: string
}> = [
	{
		videoId: 'iGMkgjXc8Ho',
		title: 'Build a PR-ready check in Cursor, then run it from Claude',
	},
	{
		videoId: 'QA0xYMAMjEg',
		title: 'Introducing Kody: Your Personal Software Factory',
	},
	{
		videoId: 'OZKDO9Pzmo0',
		title:
			'Shade automation from an INTENT.md — deterministic code, no model in the loop',
	},
	{
		videoId: 'aySqbxQo9lM',
		title: 'Kody enables awesome triage-to-production workflows',
	},
]
export const landingHeroDemoVideoIds = landingHeroDemoVideos.map(
	(video) => video.videoId,
)
export const landingHeroDemoVideoId = landingHeroDemoVideoIds[0] ?? ''
export const landingHeroDemoPlaylistId = 'PLXa53KPj2nlE'
export const landingHeroChooserLabel = 'More Kody videos'
