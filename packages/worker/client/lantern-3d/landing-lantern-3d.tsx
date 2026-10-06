import { type Handle, ref } from 'remix/component'
import { observeNearViewport } from '#client/deferred-turnstile.ts'
import { on } from '#client/event-mixin.ts'
import {
	LandingLantern,
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
	type LanternMotion,
	type LanternPalette,
	type LanternScene,
	type LanternSceneFrame,
} from './lantern-3d-scene.ts'

/**
 * The primitives lantern in 3D, with the 2D lantern as its poster. The page
 * ships the 2D one, and it stays for no-JS, no WebGL2, Save-Data, and a lost
 * GPU context. Near the viewport the scene loads in its own chunk, draws a
 * first frame with the orbs where the 2D ones are, and fades in over it.
 *
 * Each orb has an invisible button that follows it every frame, so hover,
 * focus, click, Escape, and the leader lines work as they do in 2D. Drag the
 * lantern to turn it (a flick spins it, and the fluid inside carries the
 * orbs round), drag an orb to toss it, tap the glass to jostle it, and click
 * an orb for a burst as its word opens. Arrow keys on an orb and the spin
 * button turn it from the keyboard.
 */

type Stage = 'poster' | 'loading' | 'live' | 'failed'

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

export type LandingLantern3dProps = Omit<LandingLanternProps, 'decorative'>

export function LandingLantern3d(handle: Handle<LandingLantern3dProps>) {
	let stage: Stage = 'poster'
	let posterShown = true
	let scene: LanternScene | null = null
	let lastFrame: LanternSceneFrame | null = null
	let wrapper: HTMLElement | null = null
	let figure: HTMLElement | null = null
	let canvas: HTMLCanvasElement | null = null
	let inView = false
	let revealTimer: ReturnType<typeof setTimeout> | null = null
	const hotspots = new Map<LandingPrimitiveId, HTMLElement>()

	handle.signal.addEventListener('abort', () => {
		if (revealTimer !== null) clearTimeout(revealTimer)
		scene?.dispose()
		scene = null
	})

	function leave(id: LandingPrimitiveId) {
		handle.props.onClose(id)
		handle.props.onResume(id)
	}

	function arm() {
		if (stage !== 'poster' || handle.signal.aborted) return
		stage = 'loading'
		void handle.update().then(() => start())
	}

	async function start() {
		const host = figure
		const surface = canvas
		if (!host || !surface || handle.signal.aborted) return
		// Vite folds this to `true` in the server build, which then drops the
		// scene chunk from the Worker. Only a browser ever starts the scene.
		if (import.meta.env.SSR) return
		try {
			// Dynamic import is intentional so three.js and the scene stay out
			// of the homepage chunk (sanctioned exception to the
			// no-inline-imports rule).
			const { createLanternScene } = await import('./lantern-3d-scene.ts')
			if (handle.signal.aborted || stage !== 'loading') return
			const created = createLanternScene({
				canvas: surface,
				frame: host,
				palette: readPalette(host),
				motion: readMotion(),
				onFrame: placeHotspots,
				onLost: fail,
			})
			scene = created
			created.setVisible(inView)
			await created.ready
			if (scene !== created) return
			created.placeOrbs(posterOrbs())
			created.setActive(handle.props.activeId)
			reveal(created)
		} catch {
			fail()
		}
	}

	function reveal(live: LanternScene) {
		const focused = focusedPosterOrb()
		stage = 'live'
		void handle.update().then(() => {
			if (focused) hotspots.get(focused)?.focus({ preventScroll: true })
		})
		revealTimer = setTimeout(() => {
			revealTimer = null
			if (scene !== live) return
			posterShown = false
			void handle.update()
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
		stage = 'failed'
		posterShown = true
		void handle.update()
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

	/** The 2D orb centres, in frame pixels, for the 3D ones to start on. */
	function posterOrbs() {
		const poster = wrapper?.querySelector('.landing-lantern-3d-poster')
		const box = poster?.getBoundingClientRect()
		if (!poster || !box || box.width === 0) return []
		return landingPrimitiveIds.flatMap((id) => {
			const orb = poster.querySelector(`[data-orb="${id}"]`)
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
		const poster = wrapper?.querySelector('.landing-lantern-3d-poster')
		if (!(active instanceof HTMLElement) || !poster?.contains(active)) {
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

	const wrapperRef = ref((node: Element, signal: AbortSignal) => {
		if (!(node instanceof HTMLElement)) return
		wrapper = node
		if (!supports3d()) return
		const stop = observeNearViewport(node, () => whenIdle(arm), '600px')
		signal.addEventListener('abort', stop)
	})

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
		if (wrapper) resize.observe(wrapper)
		window.addEventListener('resize', () => scene?.layout(), { signal })
		const visibility = new IntersectionObserver(([entry]) => {
			inView = entry?.isIntersecting ?? false
			scene?.setVisible(inView)
		})
		visibility.observe(node)
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
		const {
			activeId,
			panelId,
			onOpen,
			onToggle,
			onClose,
			onDismiss,
			onResume,
		} = handle.props
		handle.queueTask(() => scene?.setActive(handle.props.activeId))
		const live = stage === 'live'
		return (
			<div class="landing-lantern-3d" data-stage={stage} mix={wrapperRef}>
				{stage === 'loading' || live ? (
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
				) : null}
				{posterShown ? (
					<div
						class="landing-lantern-3d-poster"
						inert={live ? true : undefined}
					>
						<LandingLantern
							activeId={activeId}
							panelId={panelId}
							onOpen={onOpen}
							onToggle={onToggle}
							onClose={onClose}
							onDismiss={onDismiss}
							onResume={onResume}
						/>
					</div>
				) : null}
			</div>
		)
	}
}

function isPrimitiveId(value: string | undefined): value is LandingPrimitiveId {
	return landingPrimitiveIds.some((id) => id === value)
}

/** WebGL2 (three.js needs it), and no Save-Data request. */
function supports3d() {
	if (typeof WebGL2RenderingContext === 'undefined') return false
	const connection: { saveData?: boolean } | undefined = Reflect.get(
		navigator,
		'connection',
	)
	return connection?.saveData !== true
}

/** Off the critical path: building the scene takes a few main-thread
 *  frames, so let the page settle first. */
function whenIdle(task: () => void) {
	if ('requestIdleCallback' in window) {
		window.requestIdleCallback(task, { timeout: 1500 })
	} else {
		setTimeout(task, 120)
	}
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
	return {
		color: (id) => style.getPropertyValue(`--primitive-${id}`),
		dark: matchMedia('(prefers-color-scheme: dark)').matches,
	}
}
