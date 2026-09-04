import { type Handle, type RemixNode, ref } from 'remix/ui'
import {
	isElementNearViewport,
	observeNearViewport,
} from '#client/deferred-turnstile.ts'
import { on } from '#client/event-mixin.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { routes } from '#universal/routes.ts'
import {
	walkthroughHostForAct,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { type TranscriptLine } from './interactive-guide-transcript.ts'
import { fetchLandingLoopHighlights } from './landing-loop-highlights.ts'
import {
	createLandingLoopPlayer,
	flattenTranscriptActs,
	groupLandingLoopScenes,
	landingLoopChatScrollShouldExplore,
	landingLoopHoldMs,
	landingLoopTeaser,
	landingLoopToggleLabel,
	waitLandingLoopHold,
	type LandingLoopBeat,
	type LandingLoopSceneGroup,
	type LandingLoopToggleLabel,
} from './landing-loop-state.ts'
import { renderWalkthroughKicker } from './walkthrough-ask-kicker.tsx'

type LoopLineRenderer = (line: TranscriptLine, actId: string) => RemixNode

/**
 * Homepage factory-loop player. SSR paints the first user turn; the
 * transcript chunk loads once the card is near the viewport so it stays
 * out of the marketing entry. Walkthrough highlight tokens fetch in
 * parallel so tool/file beats paint colored spans instead of plaintext.
 * Hover/focus (fine pointers) and explore (scroll up or open a tool)
 * pause the autoplay; Play scrolls to the latest beat and continues.
 * The last beat pauses and offers Restart instead of looping. One
 * header control is both the playing indicator and play/pause (icons,
 * not words). SSR paints Pause so the header does not shift when the
 * transcript chunk loads. A reserved slot keeps that size if
 * reduced-motion later hides it. Later acts stay in the same card, each
 * introduced by a time-skip rule. Host marks come from SSR/loader props
 * so hydrate matches the pick.
 */
export function LandingLoopPlayer(
	handle: Handle<{ hosts?: WalkthroughHostPick }>,
) {
	let beats: Array<LandingLoopBeat> | null = null
	let renderLine: LoopLineRenderer | null = null
	let highlightsPromise: Promise<Record<string, HighlightedCode>> | null = null
	let player = createLandingLoopPlayer({ beatCount: 1, reducedMotion: false })
	let reducedMotion = false
	let finePointerPauses = false
	let chatEl: HTMLElement | null = null
	let autoScrolling = false
	let chatUserDriven = false
	let playGeneration = 0
	let loadStarted = false
	let heldPause = false
	let loopEl: HTMLElement | null = null
	let visibleInViewport = true
	let pendingSkip = false

	function prefersReducedMotion() {
		return (
			typeof matchMedia === 'function' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches
		)
	}

	function canFinePointerPause() {
		return (
			typeof matchMedia === 'function' &&
			matchMedia('(hover: hover) and (pointer: fine)').matches
		)
	}

	function startHighlightsFetch() {
		if (highlightsPromise || handle.signal.aborted) return
		highlightsPromise = fetchLandingLoopHighlights(handle.signal)
	}

	function armLoad() {
		if (loadStarted || handle.signal.aborted) return
		loadStarted = true
		startHighlightsFetch()
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
			const [transcript, walkthrough, highlights] = await Promise.all([
				// Dynamic import is intentional so the factory transcript and
				// tool-call renderer stay out of the homepage chunk. Tokens
				// come from the How Kody works guide JSON, not client Shiki.
				import('./how-kody-works-transcript.ts'),
				import('./interactive-guide-walkthrough.tsx'),
				highlightsPromise ?? fetchLandingLoopHighlights(handle.signal),
			])
			if (handle.signal.aborted) return
			beats = flattenTranscriptActs(transcript.howKodyWorksTranscriptActs)
			renderLine = (line, actId) =>
				walkthrough.renderInteractiveGuideLine(
					line,
					highlights,
					walkthroughHostForAct(handle.props.hosts, actId),
				)
			reducedMotion = prefersReducedMotion()
			finePointerPauses = canFinePointerPause()
			player = createLandingLoopPlayer({
				beatCount: beats.length,
				reducedMotion,
			})
			if (heldPause) player.pause()
			syncVisibility()
			if (pendingSkip && !reducedMotion) {
				pendingSkip = false
				heldPause = false
				chatUserDriven = false
				playGeneration += 1
				player.skipToEnd()
				handle.update()
				handle.queueTask(() => {
					scrollChatToBottom()
				})
				return
			}
			if (!reducedMotion && !player.isPaused()) startPlayLoop()
			handle.update()
		} catch {
			// Leave the SSR teaser in place and let a later arm retry.
			loadStarted = false
		}
	}

	function markAutoScroll() {
		autoScrolling = true
		const done = () => {
			autoScrolling = false
		}
		chatEl?.addEventListener('scrollend', done, { once: true })
		window.setTimeout(done, 800)
	}

	function scrollChatToBottom() {
		if (!chatEl) return
		markAutoScroll()
		chatEl.scrollTo({
			top: chatEl.scrollHeight,
			behavior: reducedMotion ? 'auto' : 'smooth',
		})
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
				const finished = await waitLandingLoopHold({
					ms: landingLoopHoldMs(current),
					isPaused: () => player.isPaused(),
					subscribe: player.subscribe,
					signal,
				})
				if (!finished || signal.aborted || generation !== playGeneration) {
					return
				}
				if (player.isPaused()) continue
				const step = player.advance()
				await handle.update()
				if (signal.aborted || generation !== playGeneration) return
				if (step.ended) continue
				scrollChatToBottom()
			}
		})()
	}

	function playFromHere() {
		heldPause = false
		chatUserDriven = false
		player.play()
		handle.update()
		startPlayLoop()
		handle.queueTask(() => {
			scrollChatToBottom()
		})
	}

	function restartFromStart() {
		heldPause = false
		chatUserDriven = false
		player.restart()
		handle.update()
		startPlayLoop()
		handle.queueTask(() => {
			if (!chatEl) return
			markAutoScroll()
			chatEl.scrollTo({
				top: 0,
				behavior: reducedMotion ? 'auto' : 'smooth',
			})
		})
	}

	function skipToEnd() {
		if (reducedMotion || player.isEnded()) return
		if (!beats) {
			pendingSkip = true
			armLoad()
			return
		}
		heldPause = false
		chatUserDriven = false
		playGeneration += 1
		player.skipToEnd()
		handle.update()
		handle.queueTask(() => {
			scrollChatToBottom()
		})
	}

	return () => {
		if (typeof document !== 'undefined') startHighlightsFetch()
		const visibleBeats = beats?.slice(0, player.revealedCount) ?? null
		const sceneGroups = visibleBeats ? groupLandingLoopScenes(visibleBeats) : []
		const lineRenderer = renderLine
		const loaded = visibleBeats != null && lineRenderer != null
		const ended = loaded && player.isEnded() && !reducedMotion
		const userPaused =
			heldPause ||
			player.pauseReasons().some((reason) => reason !== 'offscreen')
		const paused = userPaused && !reducedMotion
		const playing = loaded && !player.isPaused() && !reducedMotion && !heldPause
		const toggleLabel = landingLoopToggleLabel({
			reducedMotion,
			ended,
			paused,
		})

		return (
			<div
				class="landing-loop"
				data-paused={paused ? 'true' : undefined}
				data-playing={playing ? 'true' : undefined}
				data-ended={ended ? 'true' : undefined}
				aria-label="Factory loop conversation"
				mix={[
					on('pointerenter', () => {
						if (!finePointerPauses) return
						player.setHover(true)
						handle.update()
					}),
					on('pointerleave', () => {
						if (!finePointerPauses) return
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
					<p class="landing-loop-title">
						<span class="landing-loop-title-full">
							Example conversation with your agents and Kody
						</span>
						<span class="landing-loop-title-short">Example conversation</span>
					</p>
					<span class="landing-loop-toggle-slot">
						{toggleLabel ? (
							<>
								<button
									type="button"
									class="landing-loop-toggle"
									aria-label={toggleLabel}
									mix={on('click', () => {
										if (player.isEnded()) restartFromStart()
										else if (player.isPaused() || heldPause) playFromHere()
										else {
											heldPause = true
											player.pause()
											handle.update()
										}
									})}
								>
									<span class="landing-loop-status-dot"></span>
									{renderLoopToggleIcon(toggleLabel)}
								</button>
								<button
									type="button"
									class="landing-loop-toggle"
									aria-label="Skip to the end"
									title="Skip to the end"
									mix={on('click', skipToEnd)}
								>
									{renderLoopSkipIcon()}
								</button>
							</>
						) : null}
					</span>
				</div>
				<div
					class="landing-loop-chat"
					mix={[
						on('pointerdown', () => {
							chatUserDriven = true
						}),
						on('wheel', () => {
							chatUserDriven = true
						}),
						on('focusin', () => {
							if (!finePointerPauses) return
							player.setFocus(true)
							handle.update()
						}),
						on('focusout', (event) => {
							if (!finePointerPauses) return
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
							if (!chatEl) return
							const slack = 28
							const atBottom =
								chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight <=
								slack
							if (
								!landingLoopChatScrollShouldExplore({
									autoScrolling,
									userDriven: chatUserDriven,
									atBottom,
								})
							) {
								return
							}
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
						? sceneGroups.map((group, groupIndex) =>
								renderSceneGroup(
									group,
									groupIndex,
									lineRenderer,
									groupIndex === sceneGroups.length - 1,
									handle.props.hosts,
								),
							)
						: renderTeaser(handle.props.hosts)}
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

function renderSceneGroup(
	group: LandingLoopSceneGroup,
	groupIndex: number,
	lineRenderer: LoopLineRenderer,
	newestGroup: boolean,
	hosts?: WalkthroughHostPick,
) {
	const lines = group.beats.map((beat, index) =>
		renderBeat(
			beat,
			lineRenderer,
			`${beatKey(beat)}-${index}`,
			newestGroup && index === group.beats.length - 1,
			hosts,
		),
	)
	return (
		<div key={`scene-${group.scene}-${groupIndex}`} class="landing-loop-scene">
			{groupIndex > 0 ? (
				<p class="landing-loop-later" aria-hidden="true">
					{landingLoopLaterLabel(group)}
				</p>
			) : null}
			{lines}
		</div>
	)
}

function landingLoopLaterLabel(group: LandingLoopSceneGroup) {
	const header = group.beats[0]
	if (header?.kind === 'act' && header.later) return header.later
	return 'Later'
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
	hosts?: WalkthroughHostPick,
) {
	if (beat.kind === 'act') {
		return (
			<header
				key={key}
				class="landing-loop-act"
				data-newest={newest ? 'true' : undefined}
			>
				{beat.kicker ? (
					<p class="landing-loop-kicker">
						{renderWalkthroughKicker(beat.kicker, hosts)}
					</p>
				) : null}
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
			{renderLine(beat.line, beat.actId)}
		</div>
	)
}

function renderTeaser(hosts?: WalkthroughHostPick) {
	return (
		<>
			<header class="landing-loop-act">
				{landingLoopTeaser.kicker ? (
					<p class="landing-loop-kicker">
						{renderWalkthroughKicker(landingLoopTeaser.kicker, hosts)}
					</p>
				) : null}
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

function renderLoopToggleIcon(label: LandingLoopToggleLabel) {
	switch (label) {
		case 'Pause':
			return (
				<svg
					viewBox="0 0 24 24"
					width="1em"
					height="1em"
					aria-hidden="true"
					fill="currentColor"
				>
					<rect x="6" y="5" width="4.5" height="14" rx="1" />
					<rect x="13.5" y="5" width="4.5" height="14" rx="1" />
				</svg>
			)
		case 'Play':
			return (
				<svg
					viewBox="0 0 24 24"
					width="1em"
					height="1em"
					aria-hidden="true"
					fill="currentColor"
				>
					<path d="M8 5.5v13l11-6.5-11-6.5Z" />
				</svg>
			)
		case 'Restart':
			return (
				<svg
					viewBox="0 0 24 24"
					width="1em"
					height="1em"
					aria-hidden="true"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M9 14 4 9l5-5" />
					<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" />
				</svg>
			)
		default: {
			const exhaustive: never = label
			return exhaustive
		}
	}
}

function renderLoopSkipIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="1em"
			height="1em"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M12 5v14" />
			<path d="m19 12-7 7-7-7" />
		</svg>
	)
}
