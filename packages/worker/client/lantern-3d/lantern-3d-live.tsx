import { type Handle, ref } from 'remix/component'
import { routerEvents } from '#client/client-router.tsx'
import { isElementNearViewport } from '#client/deferred-turnstile.ts'
import { on } from '#client/event-mixin.ts'
import {
	hoverPointer,
	type LandingLanternProps,
} from '#client/routes/landing-lantern.tsx'
import {
	lanternOrbMotionEvent,
	lanternOrbReleaseEvent,
} from '#client/routes/landing-lantern-motion.ts'
import { renderIcon } from '#universal/icon.tsx'
import { landingHomePrimitives } from '#universal/landing-home-copy.ts'
import {
	landingPrimitiveColorVar,
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'
import {
	createLanternClient,
	probeLanternGpu,
	type LanternClient,
} from './lantern-3d-client.ts'
import { declineLantern3d, whenIdle } from './lantern-3d-gate.ts'
import {
	type LanternMotion,
	type LanternPalette,
	type LanternSceneFrame,
} from './lantern-3d-protocol.ts'

export { createLanternLeaders } from './lantern-3d-leaders.ts'

/**
 * The live half of the 3D lantern, loaded once the homepage's lantern comes
 * near the viewport (see `landing-lantern-3d.tsx`, which keeps the 2D
 * lantern as the poster). A throwaway worker first asks whether WebGL here
 * runs on a GPU; without one the 2D lantern stays and the scene never
 * starts. Otherwise, once the page is idle, the scene starts in its own
 * worker and draws its first second hidden behind the poster. If that ran
 * fast enough, it moves its orbs to where the 2D ones are and fades in;
 * if not, the 2D lantern stays. A navigation holds every step of that
 * (and the frames) until it ends, and leaving the page ends the worker.
 *
 * Each orb has an invisible button that follows it every frame, so hover,
 * focus, click, Escape, and the leader lines work as they do in 2D. Drag the
 * lantern to turn it (a flick spins it, and the fluid inside carries the
 * orbs round), drag an orb to toss it, tap the glass to jostle it, and click
 * an orb for a burst as its word opens. Arrow keys on an orb and the spin
 * button turn it from the keyboard.
 */

export type LanternStage = 'poster' | 'loading' | 'live' | 'failed'

export type LandingLantern3dLiveProps = Omit<
	LandingLanternProps,
	'decorative'
> & {
	/** A client-side navigation is under way. */
	navigating: () => boolean
	/** Where the handoff is, and whether the 2D lantern still shows. */
	onStage: (stage: LanternStage, posterShown: boolean) => void
}

type Gesture = {
	pointerId: number
	pointerType: string
	/** The orb under the press, or null to turn the lantern. */
	orb: LandingPrimitiveId | null
	originX: number
	originY: number
	dragged: boolean
}

/** Movement before a press becomes a drag, as in the 2D lantern. */
const dragSlopPx = 8

/** The fade in styles.css; the poster leaves once it is done. */
const crossfadeMs = 800

const caption =
	'A glass lantern holding six glowing orbs, one for each Kody primitive. Drag the lantern to turn it, toss an orb, or pick one to read about it. With an orb focused, the left and right arrow keys turn the lantern.'

export function LandingLantern3dLive(
	handle: Handle<LandingLantern3dLiveProps>,
) {
	let stage: LanternStage = 'poster'
	let scene: LanternClient | null = null
	let lastFrame: LanternSceneFrame | null = null
	let figure: HTMLElement | null = null
	let canvas: HTMLCanvasElement | null = null
	let inView = false
	let revealTimer: ReturnType<typeof setTimeout> | null = null
	const hotspots = new Map<LandingPrimitiveId, HTMLElement>()
	let navigating = handle.props.navigating()
	let afterNavigation: Array<() => void> = []

	handle.signal.addEventListener('abort', () => {
		if (revealTimer !== null) clearTimeout(revealTimer)
		scene?.dispose()
		scene = null
		afterNavigation = []
	})

	routerEvents.addEventListener(
		'navigationstart',
		() => {
			navigating = true
			scene?.pause(true)
		},
		{ signal: handle.signal },
	)
	// Latest wins: a superseded navigation never ends, the last one does.
	routerEvents.addEventListener(
		'navigationend',
		() => {
			navigating = false
			scene?.pause(false)
			for (const resume of afterNavigation.splice(0)) resume()
		},
		{ signal: handle.signal },
	)

	handle.queueTask(() => {
		void start()
	})

	/** Resolves at once, or when the navigation under way ends. */
	function settled() {
		if (!navigating) return Promise.resolve()
		return new Promise<void>((resolve) => afterNavigation.push(resolve))
	}

	function setStage(next: LanternStage, posterShown = true) {
		stage = next
		handle.props.onStage(next, posterShown)
		return handle.update()
	}

	function leave(id: LandingPrimitiveId) {
		handle.props.onClose(id)
		handle.props.onResume(id)
	}

	async function start() {
		try {
			await settled()
			if (handle.signal.aborted) return
			if (!(await probeLanternGpu())) {
				declineLantern3d('no-gpu')
				return
			}
			await settled()
			if (handle.signal.aborted) return
			await setStage('loading')
			await settled()
			await new Promise<void>((resolve) => whenIdle(resolve))
			await settled()
			const host = figure
			const surface = canvas
			if (!host || !surface || handle.signal.aborted) return
			if (stage !== 'loading') return
			const created = createLanternClient({
				canvas: surface,
				frame: host,
				palette: readPalette(host),
				motion: readMotion(),
				orbs: posterOrbs(),
				visible: shown(),
				paused: navigating,
				onFrame: placeHotspots,
				onLost: fail,
			})
			scene = created
			const speed = await created.ready
			if (scene !== created) return
			if (speed === 'slow') {
				tooSlow()
				return
			}
			// The 2D orbs drift, and the page can resize, while the worker
			// starts, so the swap begins from where they are now.
			do {
				await settled()
				if (scene !== created) return
				await created.matchPoster(posterOrbs())
				if (scene !== created) return
			} while (navigating)
			created.setActive(handle.props.activeId)
			reveal(created)
		} catch {
			fail()
		}
	}

	/** On screen in a visible tab. */
	function shown() {
		return inView && document.visibilityState !== 'hidden'
	}

	function reveal(live: LanternClient) {
		const focused = focusedPosterOrb()
		void setStage('live').then(() => {
			if (focused) hotspots.get(focused)?.focus({ preventScroll: true })
		})
		revealTimer = setTimeout(() => {
			revealTimer = null
			if (scene !== live) return
			handle.props.onStage('live', false)
			// A half turn to say hello, unless someone is already reading.
			if (!readMotion().reduced && !handle.props.activeId) live.spin(1)
		}, crossfadeMs)
	}

	function fail() {
		if (stage === 'failed') return
		if (revealTimer !== null) clearTimeout(revealTimer)
		revealTimer = null
		scene?.dispose()
		scene = null
		void setStage('failed')
	}

	/** The scene drew too slow to show: back to the 2D lantern, here and on
	 *  later visits in this tab. */
	function tooSlow() {
		declineLantern3d('slow')
		scene?.dispose()
		scene = null
		void setStage('poster')
	}

	function placeHotspots(frame: LanternSceneFrame) {
		lastFrame = frame
		if (stage !== 'live' || frame.width === 0) return
		for (const id of landingPrimitiveIds) placeHotspot(id)
		// Same frame as the orbs, so the leader lines meet them.
		figure?.dispatchEvent(
			new CustomEvent(lanternOrbMotionEvent, { bubbles: true }),
		)
	}

	function placeHotspot(id: LandingPrimitiveId) {
		const hotspot = hotspots.get(id)
		const orb = lastFrame?.orbs.find((entry) => entry.id === id)
		if (!hotspot || !orb || !lastFrame || lastFrame.width === 0) return
		const { width, height } = lastFrame
		hotspot.style.setProperty('--x', `${((orb.x / width) * 100).toFixed(3)}%`)
		hotspot.style.setProperty('--y', `${((orb.y / height) * 100).toFixed(3)}%`)
		hotspot.style.setProperty('--size', ((orb.radius * 200) / width).toFixed(3))
		// Nearer orbs take the pointer where two overlap.
		hotspot.style.zIndex = `${orb.order}`
	}

	function poster() {
		return (
			figure
				?.closest('.landing-lantern-3d')
				?.querySelector('.landing-lantern-3d-poster') ?? null
		)
	}

	/** The 2D orb centres, in frame pixels, for the 3D ones to start on. */
	function posterOrbs() {
		const still = poster()
		const box = still?.getBoundingClientRect()
		if (!still || !box || box.width === 0) return []
		return landingPrimitiveIds.flatMap((id) => {
			const orb = still.querySelector(`[data-orb="${id}"]`)
			if (!orb) return []
			const rect = orb.getBoundingClientRect()
			return [
				{
					id,
					x: rect.left + rect.width / 2 - box.left,
					y: rect.top + rect.height / 2 - box.top,
				},
			]
		})
	}

	function focusedPosterOrb() {
		const active = document.activeElement
		if (!(active instanceof HTMLElement) || !poster()?.contains(active)) {
			return null
		}
		const id = active.dataset.orb
		return isPrimitiveId(id) ? id : null
	}

	/** A drop or toss can leave a still pointer over a moving hotspot.
	 *  That is not a new hover, so the word stays shut until the pointer
	 *  moves off it (as in the 2D lantern). */
	function releaseHover(
		id: LandingPrimitiveId,
		tossed: boolean,
		clientX: number,
		clientY: number,
	) {
		const hotspot = hotspots.get(id)
		if (!hotspot) return
		hotspot.dataset.suppressHover = ''
		if (document.activeElement === hotspot) hotspot.blur()
		hotspot.dispatchEvent(new Event(lanternOrbReleaseEvent))
		if (tossed) return
		const hit = document.elementFromPoint(clientX, clientY)
		if (hit instanceof Node && hotspot.contains(hit)) {
			delete hotspot.dataset.suppressHover
		}
	}

	function clearSuppressedHover(event: PointerEvent) {
		let hit: Element | null | undefined
		for (const hotspot of hotspots.values()) {
			if (hotspot.dataset.suppressHover == null) continue
			hit ??= document.elementFromPoint(event.clientX, event.clientY)
			if (hit instanceof Node && hotspot.contains(hit)) continue
			delete hotspot.dataset.suppressHover
		}
	}

	const canvasRef = ref((node: Element) => {
		if (node instanceof HTMLCanvasElement) canvas = node
	})

	const figureRef = ref((node: Element, signal: AbortSignal) => {
		if (!(node instanceof HTMLElement)) return
		figure = node
		const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
		const narrow = matchMedia('(max-width: 800px)')
		const dark = matchMedia('(prefers-color-scheme: dark)')
		let gesture: Gesture | null = null
		let swallowClick = false
		let swallowFrame: number | null = null

		const clearGrabChrome = () => {
			delete node.dataset.grabbing
			document.documentElement.style.cursor = ''
			for (const hotspot of hotspots.values()) delete hotspot.dataset.grabbed
		}

		const endGesture = (event: PointerEvent, flick: boolean) => {
			if (!gesture || event.pointerId !== gesture.pointerId) return
			const { orb, dragged } = gesture
			gesture = null
			clearGrabChrome()
			if (!scene) return
			if (!dragged) {
				// A tap on the glass, not on an orb: give it a jostle.
				if (!orb && flick) scene.nudge()
				return
			}
			if (orb) {
				const tossed = scene.releaseOrb(flick)
				releaseHover(orb, tossed, event.clientX, event.clientY)
			} else {
				scene.endTurn(flick)
			}
			swallowClick = true
			// Click follows pointerup in this task. Drop the flag on the next
			// frame so a later keyboard activation still toggles.
			if (swallowFrame !== null) cancelAnimationFrame(swallowFrame)
			swallowFrame = requestAnimationFrame(() => {
				swallowFrame = null
				swallowClick = false
			})
		}

		node.addEventListener(
			'pointerdown',
			(event) => {
				if (gesture || !scene || stage !== 'live') return
				swallowClick = false
				if (event.button !== 0 || !(event.target instanceof Element)) return
				if (event.target.closest('.landing-lantern-3d-spin')) return
				const hotspot = event.target.closest<HTMLElement>('[data-orb]')
				const orb =
					hotspot && isPrimitiveId(hotspot.dataset.orb)
						? hotspot.dataset.orb
						: null
				gesture = {
					pointerId: event.pointerId,
					pointerType: event.pointerType,
					orb,
					originX: event.clientX,
					originY: event.clientY,
					dragged: false,
				}
				const captor = hotspot ?? node
				try {
					captor.setPointerCapture(event.pointerId)
				} catch {
					// The pointer can already be inactive. Window moves still
					// drag, and pointerup ends the gesture.
				}
			},
			{ signal },
		)
		node.addEventListener(
			'click',
			(event) => {
				if (!swallowClick) return
				swallowClick = false
				event.preventDefault()
				event.stopPropagation()
			},
			{ capture: true, signal },
		)
		window.addEventListener(
			'pointermove',
			(event) => {
				if (!scene || stage !== 'live') return
				if (event.pointerType !== 'touch') {
					scene.look(event.clientX, event.clientY)
				}
				if (!gesture) {
					clearSuppressedHover(event)
					return
				}
				if (event.pointerId !== gesture.pointerId) return
				if (!gesture.dragged) {
					const travel = Math.hypot(
						event.clientX - gesture.originX,
						event.clientY - gesture.originY,
					)
					if (travel < dragSlopPx) return
					gesture.dragged = true
					if (gesture.orb) {
						scene.grabOrb(gesture.orb, gesture.originX, gesture.originY)
						const hotspot = hotspots.get(gesture.orb)
						if (hotspot) hotspot.dataset.grabbed = ''
					} else {
						scene.beginTurn(gesture.originX, gesture.originY)
					}
					node.dataset.grabbing = ''
					document.documentElement.style.cursor = 'grabbing'
					// A touch drag focuses the orb and would leave the bottom
					// sheet open after the flick. A tap still focuses and toggles.
					if (gesture.pointerType === 'touch') {
						const active = document.activeElement
						if (active instanceof HTMLElement && node.contains(active)) {
							active.blur()
						}
					}
				}
				if (gesture.orb) scene.moveOrb(event.clientX, event.clientY)
				else scene.turn(event.clientX, event.clientY)
				if (event.cancelable) event.preventDefault()
			},
			{ signal },
		)
		window.addEventListener('pointerup', (event) => endGesture(event, true), {
			signal,
		})
		window.addEventListener(
			'pointercancel',
			(event) => endGesture(event, false),
			{ signal },
		)
		document.documentElement.addEventListener(
			'pointerleave',
			() => scene?.stopLooking(),
			{ signal },
		)

		const resize = new ResizeObserver(() => scene?.layout())
		resize.observe(node)
		window.addEventListener('resize', () => scene?.layout(), { signal })
		const visibility = new IntersectionObserver(([entry]) => {
			inView = entry?.isIntersecting ?? false
			scene?.setVisible(shown())
		})
		// Some mobile browsers skip the first callback for a node already on
		// screen, and a hidden scene never wakes.
		inView = isElementNearViewport(node, '0px')
		visibility.observe(node)
		document.addEventListener(
			'visibilitychange',
			() => scene?.setVisible(shown()),
			{ signal },
		)
		const onMotion = () => scene?.setMotion(readMotion())
		motionOk.addEventListener('change', onMotion, { signal })
		narrow.addEventListener('change', onMotion, { signal })
		dark.addEventListener(
			'change',
			() => scene?.setPalette(readPalette(node)),
			{
				signal,
			},
		)

		signal.addEventListener('abort', () => {
			resize.disconnect()
			visibility.disconnect()
			if (swallowFrame !== null) cancelAnimationFrame(swallowFrame)
			clearGrabChrome()
			if (figure === node) figure = null
		})
	})

	function renderHotspot(id: LandingPrimitiveId) {
		const { activeId, panelId, onOpen, onToggle, onDismiss } = handle.props
		const primitive = landingHomePrimitives.find((entry) => entry.id === id)
		const open = activeId === id
		return (
			<button
				key={id}
				type="button"
				class="landing-lantern-3d-orb"
				data-orb={id}
				data-open={open ? '' : undefined}
				style={{ '--primitive-color': landingPrimitiveColorVar(id) }}
				aria-label={`${primitive?.word ?? id} primitive`}
				aria-expanded={open ? 'true' : 'false'}
				aria-controls={panelId(id)}
				aria-describedby={panelId(id)}
				mix={[
					ref((node: Element, signal: AbortSignal) => {
						if (!(node instanceof HTMLElement)) return
						hotspots.set(id, node)
						placeHotspot(id)
						signal.addEventListener('abort', () => {
							if (hotspots.get(id) === node) hotspots.delete(id)
						})
					}),
					on('pointerenter', (event: PointerEvent) => {
						if (!hoverPointer(event)) return
						const current = event.currentTarget
						if (
							current instanceof HTMLElement &&
							current.dataset.suppressHover != null
						) {
							return
						}
						onOpen(id)
					}),
					on('pointerleave', (event: PointerEvent) => {
						if (!hoverPointer(event)) return
						// A captured drag leaves the hotspot without ending the
						// grab. The release event closes it.
						const current = event.currentTarget
						if (
							current instanceof Element &&
							current.hasPointerCapture(event.pointerId)
						) {
							return
						}
						leave(id)
					}),
					on(lanternOrbReleaseEvent, () => leave(id)),
					on('focusin', () => onOpen(id)),
					on('focusout', () => leave(id)),
					on('click', () => {
						onToggle(id)
						scene?.celebrate(id)
					}),
					on('keydown', (event: KeyboardEvent) => {
						if (event.key === 'Escape') {
							event.preventDefault()
							onDismiss(id)
							return
						}
						const direction =
							event.key === 'ArrowLeft'
								? -1
								: event.key === 'ArrowRight'
									? 1
									: 0
						if (direction === 0) return
						event.preventDefault()
						scene?.spin(direction)
					}),
				]}
			/>
		)
	}

	return () => {
		handle.queueTask(() => scene?.setActive(handle.props.activeId))
		const live = stage === 'live'
		if (stage !== 'loading' && !live) return null
		return (
			<figure
				class="landing-lantern landing-lantern-3d-scene"
				aria-hidden={live ? undefined : 'true'}
				mix={figureRef}
			>
				{live ? (
					<figcaption class="visually-hidden">{caption}</figcaption>
				) : null}
				<canvas
					class="landing-lantern-3d-canvas"
					aria-hidden="true"
					mix={canvasRef}
				/>
				{live ? (
					<div class="landing-lantern-3d-orbs">
						{landingPrimitiveIds.map(renderHotspot)}
					</div>
				) : null}
				{live ? (
					<button
						type="button"
						class="landing-lantern-3d-spin"
						aria-label="Spin the lantern"
						title="Spin the lantern"
						mix={on('click', () => scene?.spin(1, true))}
					>
						{renderIcon('refresh', { size: '1.1rem' })}
					</button>
				) : null}
			</figure>
		)
	}
}

function isPrimitiveId(value: string | undefined): value is LandingPrimitiveId {
	return landingPrimitiveIds.some((id) => id === value)
}

function readMotion(): LanternMotion {
	return {
		reduced: !matchMedia('(prefers-reduced-motion: no-preference)').matches,
		// A phone gets a shorter wander, as in the 2D lantern.
		wander: matchMedia('(max-width: 800px)').matches ? 0.62 : 1,
	}
}

function readPalette(element: Element): LanternPalette {
	const style = getComputedStyle(element)
	const color = (id: LandingPrimitiveId) =>
		style.getPropertyValue(`--primitive-${id}`).trim()
	return {
		colors: {
			memory: color('memory'),
			secrets: color('secrets'),
			packages: color('packages'),
			triggers: color('triggers'),
			integrations: color('integrations'),
			apps: color('apps'),
		},
		dark: matchMedia('(prefers-color-scheme: dark)').matches,
	}
}
