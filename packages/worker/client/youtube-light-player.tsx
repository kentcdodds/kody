import { css, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	youtubeNocookieEmbedUrl,
	youtubeThumbPath,
} from '#universal/youtube-watch.ts'
import { colors, radius, typography } from '#universal/styles/tokens.ts'

/**
 * First-party lite YouTube player: poster + play, then the privacy-enhanced
 * embed. Used by the site-wide `/?youtubeId=` overlay and the homepage hero.
 * Playback starts on click so `prefers-reduced-motion` never autoplays; the
 * one exception is `autoplay`, which callers set only after the visitor has
 * already picked a video (a click is the gesture). When `videoId` changes the
 * player re-derives its state for the new video instead of carrying the old
 * one over. The same `videoId` still starts when `autoplay` becomes true so
 * the hero chooser can play the already-selected clip.
 */
export function nextLightPlayerPlaying(input: {
	playing: boolean
	renderedVideoId: string
	videoId: string
	autoplay: boolean
}) {
	if (input.videoId !== input.renderedVideoId) {
		return {
			renderedVideoId: input.videoId,
			playing: input.autoplay,
		}
	}
	return {
		renderedVideoId: input.renderedVideoId,
		playing: input.playing || input.autoplay,
	}
}

export function YouTubeLightPlayer(
	handle: Handle<{
		videoId: string
		playlistId?: string
		title?: string
		playTestId?: string
		autoplay?: boolean
	}>,
) {
	let renderedVideoId = handle.props.videoId
	let playing = handle.props.autoplay === true

	return () => {
		const videoId = handle.props.videoId
		const next = nextLightPlayerPlaying({
			playing,
			renderedVideoId,
			videoId,
			autoplay: handle.props.autoplay === true,
		})
		renderedVideoId = next.renderedVideoId
		playing = next.playing
		const title = handle.props.title ?? 'YouTube video'
		if (playing) {
			return (
				<iframe
					title={title}
					src={youtubeNocookieEmbedUrl(videoId, {
						playlistId: handle.props.playlistId,
					})}
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
					allowFullScreen
					mix={css(frameCss)}
				/>
			)
		}

		return (
			<button
				type="button"
				data-testid={handle.props.playTestId}
				mix={[
					css(posterButtonCss),
					on('click', () => {
						playing = true
						handle.update()
					}),
				]}
			>
				<img
					src={youtubeThumbPath(videoId)}
					alt=""
					width={1280}
					height={720}
					mix={css(posterImageCss)}
				/>
				<span mix={css(playBadgeCss)} aria-hidden="true">
					▶
				</span>
				<span mix={css(visuallyHiddenCss)}>Play video</span>
			</button>
		)
	}
}

const frameCss = {
	width: '100%',
	height: '100%',
	border: 'none',
}

const posterButtonCss = {
	appearance: 'none',
	display: 'block',
	width: '100%',
	height: '100%',
	padding: 0,
	border: 'none',
	backgroundColor: '#000',
	cursor: 'pointer',
	position: 'relative' as const,
}

const posterImageCss = {
	width: '100%',
	height: '100%',
	objectFit: 'cover' as const,
}

const playBadgeCss = {
	position: 'absolute' as const,
	inset: 0,
	margin: 'auto',
	width: '4.5rem',
	height: '4.5rem',
	borderRadius: radius.full,
	backgroundColor: 'rgba(0, 0, 0, 0.72)',
	color: colors.onPrimary,
	display: 'grid',
	placeItems: 'center',
	fontSize: '1.5rem',
	lineHeight: 1,
}

const visuallyHiddenCss = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden' as const,
	clip: 'rect(0, 0, 0, 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
	fontFamily: typography.fontFamily,
}
