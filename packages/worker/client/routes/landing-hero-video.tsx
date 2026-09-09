import { ref, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { YouTubeLightPlayer } from '#client/youtube-light-player.tsx'
import {
	landingHeroChooserLabel,
	landingHeroDemoPlaylistId,
	landingHeroDemoVideos,
} from '#universal/landing-hero-copy.ts'
import { youtubeThumbPath } from '#universal/youtube-watch.ts'

/**
 * Where a keypress moves the chooser's active thumbnail. `null` means the key
 * is not a navigation key. Arrows wrap at both ends so a long strip can be
 * walked in either direction from wherever the visitor is. Both axes are
 * accepted so up/down feel natural on a touch-scrolled strip too.
 */
export function nextChooserIndex(
	current: number,
	key: string,
	count: number,
): number | null {
	if (count <= 0) return null
	switch (key) {
		case 'ArrowRight':
		case 'ArrowDown':
			return (current + 1) % count
		case 'ArrowLeft':
		case 'ArrowUp':
			return (current - 1 + count) % count
		case 'Home':
			return 0
		case 'End':
			return count - 1
		default:
			return null
	}
}

/**
 * Which edges of a horizontal scroller have more content past them. Drives
 * the fade masks so an edge only fades when there is something to scroll to.
 */
export function chooserOverflow(input: {
	scrollLeft: number
	clientWidth: number
	scrollWidth: number
}) {
	return {
		start: input.scrollLeft > 1,
		end: input.scrollLeft + input.clientWidth < input.scrollWidth - 1,
	}
}

function prefersReducedMotion() {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	)
}

/**
 * Hero media column: the lite player plus a single-tab-stop listbox of
 * thumbnails under it, laid out as a horizontally scrolling strip so the list
 * can grow. Clicking a thumbnail (or Enter/Space on the active one) swaps the
 * video in the player and starts it, since choosing a video is the play
 * gesture. Arrow keys move the active thumbnail (wrapping) and scroll it into
 * view without changing the video; hover and keyboard-active both zoom the
 * whole thumbnail (neighbours step aside) and slide its title out from behind
 * it (see `.landing-hero-chooser*` in styles.css). Choosing moves focus to the
 * player.
 */
export function LandingHeroVideo(handle: Handle) {
	const videos = landingHeroDemoVideos
	let selectedIndex = 0
	let activeIndex = 0
	let chosen = false
	let scroller: HTMLElement | null = null
	let overflowStart = false
	let overflowEnd = false
	const playerId = `${handle.id}-player`

	function optionId(index: number) {
		return `${handle.id}-video-${index}`
	}

	function syncOverflow() {
		if (!scroller) return
		const next = chooserOverflow(scroller)
		if (next.start === overflowStart && next.end === overflowEnd) return
		overflowStart = next.start
		overflowEnd = next.end
		handle.update()
	}

	// Centre the option in the strip; horizontal only, so the page never
	// jumps the way `scrollIntoView` can when the hero is partly off-screen.
	function revealOption(index: number) {
		handle.queueTask(() => {
			const option = document.getElementById(optionId(index))
			if (!scroller || !option) return
			const left =
				option.offsetLeft - (scroller.clientWidth - option.offsetWidth) / 2
			scroller.scrollTo({
				left,
				behavior: prefersReducedMotion() ? 'auto' : 'smooth',
			})
		})
	}

	// Choosing hands focus to the player so keyboard control (space, arrows,
	// captions) lands on the video the visitor just picked instead of leaving
	// them parked on the strip.
	function focusPlayer() {
		handle.queueTask(() => {
			const frame = document
				.getElementById(playerId)
				?.querySelector<HTMLIFrameElement>('iframe')
			frame?.focus({ preventScroll: true })
		})
	}

	function choose(index: number) {
		if (index < 0 || index >= videos.length) return
		selectedIndex = index
		activeIndex = index
		chosen = true
		handle.update()
		revealOption(index)
		focusPlayer()
	}

	function attachScroller(node: HTMLElement, signal: AbortSignal) {
		scroller = node
		const observer = new ResizeObserver(syncOverflow)
		observer.observe(node)
		node.addEventListener('scroll', syncOverflow, { signal, passive: true })
		signal.addEventListener(
			'abort',
			() => {
				observer.disconnect()
				scroller = null
			},
			{ once: true },
		)
	}

	return () => {
		const selected = videos[selectedIndex]
		if (!selected) return null

		return (
			<div class="landing-hero-media">
				<div
					id={playerId}
					data-rise
					style={{ '--rise': '1' }}
					class="landing-hero-video"
				>
					<YouTubeLightPlayer
						videoId={selected.videoId}
						playlistId={landingHeroDemoPlaylistId}
						title={selected.title}
						autoplay={chosen}
						playTestId="landing-hero-video-play"
					/>
				</div>
				{videos.length > 1 ? (
					<div
						role="listbox"
						tabIndex={0}
						aria-label={landingHeroChooserLabel}
						aria-activedescendant={optionId(activeIndex)}
						data-rise
						style={{ '--rise': '1.5' }}
						class="landing-hero-chooser"
						data-testid="landing-hero-chooser"
						data-overflow-start={overflowStart ? '' : undefined}
						data-overflow-end={overflowEnd ? '' : undefined}
						mix={[
							ref(attachScroller),
							on('keydown', (event: KeyboardEvent) => {
								const next = nextChooserIndex(
									activeIndex,
									event.key,
									videos.length,
								)
								if (next !== null) {
									event.preventDefault()
									if (next !== activeIndex) {
										activeIndex = next
										handle.update()
										revealOption(next)
									}
									return
								}
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault()
									choose(activeIndex)
								}
							}),
						]}
					>
						{videos.map((video, index) => (
							<div
								key={video.videoId}
								id={optionId(index)}
								role="option"
								aria-selected={index === selectedIndex ? 'true' : 'false'}
								data-active={index === activeIndex ? '' : undefined}
								class="landing-hero-chooser-option"
								mix={on('click', () => choose(index))}
							>
								<span class="landing-hero-chooser-thumb">
									<img
										src={youtubeThumbPath(video.videoId)}
										alt=""
										width={480}
										height={270}
										loading="lazy"
										decoding="async"
									/>
								</span>
								<span class="landing-hero-chooser-title">{video.title}</span>
							</div>
						))}
					</div>
				) : null}
			</div>
		)
	}
}
