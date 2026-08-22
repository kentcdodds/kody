import { type Handle, type RemixNode, ref } from 'remix/ui'
import {
	isElementNearViewport,
	observeNearViewport,
} from '#client/deferred-turnstile.ts'
import { on } from '#client/event-mixin.ts'
import { loadSyntaxHighlight } from '#client/syntax-highlight.tsx'
import { whenWindowLoaded } from '#client/when-window-loaded.ts'
import { routes } from '#universal/routes.ts'
import { type TranscriptLine } from './interactive-guide-transcript.ts'
import {
	createLandingLoopPlayer,
	flattenTranscriptActs,
	landingLoopHoldMs,
	landingLoopTeaser,
	waitLandingLoopHold,
	type LandingLoopBeat,
} from './landing-loop-state.ts'

type LoopLineRenderer = (line: TranscriptLine) => RemixNode

/**
 * Homepage factory-loop player. SSR paints the first user turn; the
 * transcript chunk loads once the card is near the viewport so it stays
 * out of the marketing entry. Shiki prefetches after window `load` so
 * it does not block first paint or the first beats. Hover/focus (fine
 * pointers) and explore (scroll up or open a tool) pause the autoplay;
 * Play scrolls to the latest beat and continues.
 */
export function LandingLoopPlayer(handle: Handle) {
	let beats: Array<LandingLoopBeat> | null = null
	let renderLine: LoopLineRenderer | null = null
	let player = createLandingLoopPlayer({ beatCount: 1, reducedMotion: false })
	let reducedMotion = false
	let hoverPauses = false
	let chatEl: HTMLElement | null = null
	let autoScrolling = false
	let playGeneration = 0
	let loadStarted = false
	let loopEl: HTMLElement | null = null
	let visibleInViewport = true

	function prefersReducedMotion() {
		return (
			typeof matchMedia === 'function' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches
		)
	}

	function canHoverPause() {
		return (
			typeof matchMedia === 'function' &&
			matchMedia('(hover: hover) and (pointer: fine)').matches
		)
	}

	function armLoad() {
		if (loadStarted || handle.signal.aborted) return
		loadStarted = true
		void loadLoop()
	}

	function syncVisibility() {
		visibleInViewport = loopEl ? isElementNearViewport(loopEl, '0px') : true
		if (!beats || reducedMotion) return
		const wasPaused = player.isPaused()
		player.setOffscreen(!visibleInViewport)
		if (wasPaused && !player.isPaused()) startPlayLoop()
	}

	async function loadLoop() {
		try {
			const [transcript, walkthrough] = await Promise.all([
				// Dynamic import is intentional so the factory transcript and
				// tool-call renderer stay out of the homepage chunk. Shiki
				// stays off this path — plaintext fences are enough to start.
				import('./how-kody-works-transcript.ts'),
				import('./interactive-guide-walkthrough.tsx'),
			])
			if (handle.signal.aborted) return
			beats = flattenTranscriptActs(transcript.howKodyWorksTranscriptActs)
			renderLine = walkthrough.renderInteractiveGuideLine
			reducedMotion = prefersReducedMotion()
			hoverPauses = canHoverPause()
			player = createLandingLoopPlayer({
				beatCount: beats.length,
				reducedMotion,
			})
			syncVisibility()
			if (!reducedMotion && !player.isPaused()) startPlayLoop()
			handle.update()
		} catch {
			// Leave the SSR teaser in place and let a later arm retry.
			loadStarted = false
		}
	}

	function scrollChatToBottom() {
		if (!chatEl) return
		autoScrolling = true
		chatEl.scrollTo({
			top: chatEl.scrollHeight,
			behavior: reducedMotion ? 'auto' : 'smooth',
		})
		const done = () => {
			autoScrolling = false
		}
		chatEl.addEventListener('scrollend', done, { once: true })
		window.setTimeout(done, 480)
	}

	function startPlayLoop() {
		if (reducedMotion || !beats) return
		playGeneration += 1
		const generation = playGeneration
		const signal = handle.signal
		void (async () => {
			while (!signal.aborted && generation === playGeneration) {
				const currentBeats = beats
				if (!currentBeats || currentBeats.length === 0) return
				const current = currentBeats[player.revealedCount - 1]
				if (!current) return
				const hold =
					player.revealedCount >= currentBeats.length
						? landingLoopHoldMs('loop')
						: landingLoopHoldMs(current)
				const finished = await waitLandingLoopHold({
					ms: hold,
					isPaused: () => player.isPaused(),
					subscribe: player.subscribe,
					signal,
				})
				if (!finished || signal.aborted || generation !== playGeneration) {
					return
				}
				if (player.isPaused()) continue
				player.advance()
				await handle.update()
				if (signal.aborted || generation !== playGeneration) return
				scrollChatToBottom()
			}
		})()
	}

	function playFromHere() {
		player.play()
		handle.update()
		handle.queueTask(() => {
			scrollChatToBottom()
		})
	}

	whenWindowLoaded(() => {
		void loadSyntaxHighlight().then(() => {
			if (!handle.signal.aborted) handle.update()
		})
	}, handle.signal)

	return () => {
		const visibleBeats = beats?.slice(0, player.revealedCount) ?? null
		const lineRenderer = renderLine
		const loaded = visibleBeats != null && lineRenderer != null
		const userPaused =
			loaded && player.pauseReasons().some((reason) => reason !== 'offscreen')
		const paused = userPaused && !reducedMotion
		const playing = loaded && !player.isPaused() && !reducedMotion

		return (
			<div
				class="landing-loop"
				data-paused={paused ? 'true' : undefined}
				data-playing={playing ? 'true' : undefined}
				aria-label="Factory loop conversation"
				mix={[
					on('pointerenter', () => {
						if (!hoverPauses) return
						player.setHover(true)
						handle.update()
					}),
					on('pointerleave', () => {
						if (!hoverPauses) return
						player.setHover(false)
						handle.update()
					}),
					ref((node, signal) => {
						loopEl = node
						const stopNear = observeNearViewport(node, armLoad)
						const onVisibility = () => {
							if (isElementNearViewport(node)) armLoad()
							syncVisibility()
							if (beats) handle.update()
						}
						const visibilityObserver =
							typeof IntersectionObserver === 'undefined'
								? null
								: new IntersectionObserver(onVisibility, { threshold: 0 })
						visibilityObserver?.observe(node)
						window.addEventListener('scroll', onVisibility, {
							passive: true,
							signal,
						})
						window.addEventListener('resize', onVisibility, {
							passive: true,
							signal,
						})
						const raf = requestAnimationFrame(() => {
							if (isElementNearViewport(node)) armLoad()
						})
						signal.addEventListener(
							'abort',
							() => {
								if (loopEl === node) loopEl = null
								cancelAnimationFrame(raf)
								stopNear()
								visibilityObserver?.disconnect()
							},
							{ once: true },
						)
					}),
				]}
			>
				<div class="landing-loop-head">
					<p class="landing-loop-status" aria-hidden="true">
						<span class="landing-loop-status-dot"></span>
						{reducedMotion
							? 'The loop'
							: paused
								? 'Paused'
								: loaded
									? 'Playing'
									: 'The loop'}
					</p>
					{reducedMotion || !loaded || !(playing || paused) ? null : (
						<button
							type="button"
							class="landing-loop-toggle"
							mix={on('click', () => {
								if (player.isPaused()) playFromHere()
								else {
									player.pause()
									handle.update()
								}
							})}
						>
							{paused ? 'Play' : 'Pause'}
						</button>
					)}
				</div>
				<div
					class="landing-loop-chat"
					mix={[
						on('focusin', () => {
							player.setFocus(true)
							handle.update()
						}),
						on('focusout', (event) => {
							const next = event.relatedTarget
							if (
								next instanceof Node &&
								event.currentTarget instanceof Node &&
								event.currentTarget.contains(next)
							) {
								return
							}
							player.setFocus(false)
							handle.update()
						}),
						on('scroll', () => {
							if (!chatEl || autoScrolling) return
							const slack = 28
							const atBottom =
								chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight <=
								slack
							if (atBottom) return
							player.setExplore(true)
							handle.update()
						}),
						ref((node, signal) => {
							chatEl = node
							const onToggle = (event: Event) => {
								if (!(event.target instanceof HTMLDetailsElement)) return
								if (!event.target.open) return
								player.setExplore(true)
								handle.update()
							}
							node.addEventListener('toggle', onToggle, {
								capture: true,
								signal,
							})
							signal.addEventListener(
								'abort',
								() => {
									if (chatEl === node) chatEl = null
								},
								{ once: true },
							)
						}),
					]}
				>
					{visibleBeats && lineRenderer
						? visibleBeats.map((beat, index) =>
								renderBeat(
									beat,
									lineRenderer,
									`${beatKey(beat)}-${index}`,
									index === visibleBeats.length - 1,
								),
							)
						: renderTeaser()}
				</div>
				<p class="landing-loop-foot">
					<a href={routes.guideDetail.href({ slug: 'how-kody-works' })}>
						Read the walkthrough
					</a>
				</p>
			</div>
		)
	}
}

function beatKey(beat: LandingLoopBeat) {
	if (beat.kind === 'act') return `act-${beat.id}`
	return `line-${beat.actId}-${beat.line.role}`
}

function renderBeat(
	beat: LandingLoopBeat,
	renderLine: LoopLineRenderer,
	key: string,
	newest: boolean,
) {
	if (beat.kind === 'act') {
		return (
			<header
				key={key}
				class="landing-loop-act"
				data-newest={newest ? 'true' : undefined}
			>
				<p class="landing-loop-kicker">{beat.kicker}</p>
				<h3>{beat.title}</h3>
			</header>
		)
	}
	return (
		<div
			key={key}
			class="landing-loop-line"
			data-newest={newest ? 'true' : undefined}
		>
			{renderLine(beat.line)}
		</div>
	)
}

function renderTeaser() {
	return (
		<>
			<header class="landing-loop-act">
				<p class="landing-loop-kicker">{landingLoopTeaser.kicker}</p>
				<h3>{landingLoopTeaser.title}</h3>
			</header>
			<figure class="landing-loop-you">
				<figcaption>You</figcaption>
				<blockquote>
					<p>{landingLoopTeaser.user}</p>
				</blockquote>
			</figure>
		</>
	)
}
