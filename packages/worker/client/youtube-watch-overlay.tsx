import { css, ref, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate } from '#client/client-router.tsx'
import {
	readRouterPathname,
	readRouterSearch,
} from '#client/router-location.tsx'
import { type YoutubeWatchLoaderData } from '#universal/loader-data.ts'
import {
	parseYoutubeWatchSearch,
	stripYoutubeWatchSearch,
	youtubeNocookieEmbedUrl,
	youtubeThumbPath,
} from '#universal/youtube-watch.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export function emptyYoutubeWatchSnapshot(): YoutubeWatchLoaderData {
	return {
		allowedVideoIds: [],
		requestedVideoId: null,
	}
}

export function YouTubeWatchOverlay(
	handle: Handle<{ snapshot?: YoutubeWatchLoaderData }>,
) {
	let playing = false
	let dialogNode: HTMLDialogElement | null = null

	function closeWatch() {
		playing = false
		dialogNode?.close()
		const pathname = readRouterPathname(handle)
		const search = readRouterSearch(handle)
		const next = stripYoutubeWatchSearch(pathname, search)
		if (next !== `${pathname}${search}`) {
			navigate(next)
		}
		handle.update()
	}

	function startPlayback() {
		playing = true
		handle.update()
	}

	return () => {
		const snapshot = handle.props.snapshot ?? emptyYoutubeWatchSnapshot()
		const fromSearch = parseYoutubeWatchSearch(readRouterSearch(handle))
		const videoId = fromSearch ?? snapshot.requestedVideoId
		const allowed =
			videoId !== null && snapshot.allowedVideoIds.includes(videoId)
		if (!videoId || !allowed) return null

		const titleId = `${handle.id}-youtube-watch-title`
		return (
			<dialog
				aria-labelledby={titleId}
				data-testid="youtube-watch-overlay"
				data-video-id={videoId}
				mix={[
					css(dialogCss),
					ref((node, signal) => {
						if (!(node instanceof HTMLDialogElement)) return
						dialogNode = node
						if (
							typeof document !== 'undefined' &&
							typeof node.showModal === 'function' &&
							!node.open
						) {
							node.showModal()
						}
						signal.addEventListener('abort', () => {
							if (dialogNode === node) dialogNode = null
						})
					}),
					on('cancel', (event) => {
						event.preventDefault()
						closeWatch()
					}),
					on('click', (event) => {
						if (event.target === event.currentTarget) closeWatch()
					}),
				]}
			>
				<div mix={css(stageCss)}>
					<h2 id={titleId} mix={css(visuallyHiddenCss)}>
						Watch video
					</h2>
					{playing ? (
						<iframe
							title="YouTube video"
							src={youtubeNocookieEmbedUrl(videoId)}
							allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
							allowFullScreen
							mix={css(frameCss)}
						/>
					) : (
						<button
							type="button"
							data-testid="youtube-watch-play"
							mix={[css(posterButtonCss), on('click', startPlayback)]}
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
					)}
					<button
						type="button"
						aria-label="Close video"
						data-testid="youtube-watch-close"
						mix={[css(closeCss), on('click', closeWatch)]}
					>
						×
					</button>
				</div>
			</dialog>
		)
	}
}

const dialogCss = {
	width: 'min(96vw, 64rem)',
	maxWidth: '96vw',
	padding: 0,
	border: 'none',
	backgroundColor: 'transparent',
	'&::backdrop': {
		backgroundColor: 'rgba(0, 0, 0, 0.82)',
	},
}

const stageCss = {
	position: 'relative' as const,
	width: '100%',
	aspectRatio: '16 / 9',
	backgroundColor: '#000',
	borderRadius: radius.card,
	overflow: 'hidden' as const,
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

const closeCss = {
	position: 'absolute' as const,
	top: spacing.sm,
	right: spacing.sm,
	width: '2.25rem',
	height: '2.25rem',
	border: 'none',
	borderRadius: radius.full,
	backgroundColor: 'rgba(0, 0, 0, 0.72)',
	color: colors.onPrimary,
	fontSize: '1.5rem',
	lineHeight: 1,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: 'rgba(0, 0, 0, 0.9)',
		},
	},
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
