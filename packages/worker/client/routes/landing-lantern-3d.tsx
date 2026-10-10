import { type Handle, css, ref } from 'remix/component'
import { observeNearViewport } from '#client/deferred-turnstile.ts'
import { on } from '#client/event-mixin.ts'
import {
	LandingLantern,
	hoverPointer,
	type LandingLanternProps,
} from '#client/routes/landing-lantern.tsx'
import { lanternOrbReleaseEvent } from '#client/routes/landing-lantern-motion.ts'
import {
	lanternGlass,
	lanternViewBasis,
	projectLanternPoint,
	projectedSphereRadius,
} from '#client/routes/landing-lantern-3d-motion.ts'
import {
	lanternView,
	measureRefreshFps,
	startLanternEngine,
	type LanternEngine,
	type LanternSceneView,
} from '#client/routes/landing-lantern-3d-engine.ts'
import { hasLanternGpu } from '#client/routes/landing-lantern-3d-gpu.ts'
import { landingHomePrimitives } from '#universal/landing-home-copy.ts'
import {
	landingLanternGlass,
	landingLanternImage,
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * The primitives lantern in 3D, drawn with three.js by
 * landing-lantern-3d-scene.ts, with the same orb buttons, popovers, and
 * leader lines as the 2D lantern. The server and the first client render
 * show the 2D lantern. Near the viewport, the scene loads, mounts under
 * the still, and crossfades in once its warm-up shows the device keeps
 * up. No WebGL2, a software renderer, a slow warm-up, a failed mount, or
 * a lost GPU context keep (or bring back) the 2D lantern.
 *
 * Drag to turn the lantern; a flick keeps it spinning and the orbs lag
 * like marbles in a jar. Drag an orb to toss it. Tap the glass to flare
 * the light. Hover, focus, or the word list lights an orb and dims the
 * rest; keyboard focus and the word list turn the lantern to show that
 * orb, and the left and right arrow keys on an orb turn it. Reduced
 * motion drops the sway, drift, inertia, turns, and the idle moment; the
 * motes hold still.
 */

type Phase = 'still' | 'mounting' | 'fading' | 'live'

type LanternScene = LanternSceneView & { destroy(): void }

type MountScene = (
	canvas: HTMLCanvasElement,
	onLost: () => void,
) => Promise<LanternScene>

const fadeMs = 600
const nudgeYaw = Math.PI / 4

function percent(fraction: number) {
	return `${Math.round(fraction * 10_000) / 100}%`
}

/** Where the leader overlay should think the 2D glass is, so it finds the
 *  3D glass instead (see `leaderFollow`). */
const glassBox = (() => {
	const aspect = landingLanternImage.height / landingLanternImage.width
	const basis = lanternViewBasis()
	const size = { width: lanternView.size, height: lanternView.size * aspect }
	const pivot = { x: 0, y: 0, z: 0 }
	const centre = projectLanternPoint(basis, pivot, size)
	const radius = projectedSphereRadius(
		basis,
		pivot,
		lanternGlass.radius,
		size.height,
	)
	const share = radius / landingLanternGlass.r
	return {
		left: percent(lanternView.left + centre.x - share * landingLanternGlass.x),
		top: percent(
			lanternView.top + centre.y / aspect - share * landingLanternGlass.y,
		),
		width: percent(share),
		height: percent(share),
	}
})()

export function LandingLantern3D(handle: Handle<LandingLanternProps>) {
	let phase: Phase = 'still'
	let failed = false
	let mountScene: MountScene | null = null
	let refreshFps = 60
	let engine: LanternEngine | null = null
	let resolution = 1
	let seenActive: LandingPrimitiveId | null = null
	let openedHere: LandingPrimitiveId | null = null
	let fadeTimer: ReturnType<typeof setTimeout> | null = null

	handle.signal.addEventListener('abort', () => {
		if (fadeTimer != null) clearTimeout(fadeTimer)
	})

	function fail() {
		if (failed) return
		failed = true
		phase = 'still'
		engine = null
		handle.update()
	}

	async function load(signal: AbortSignal) {
		try {
			// Checked before the import, so a device that keeps the still
			// never downloads three.js.
			if (!hasLanternGpu()) return
			if (signal.aborted || failed) return
			const fps = measureRefreshFps(signal)
			// Dynamic import is intentional so three.js and the scene stay
			// out of the homepage chunk.
			const { mountLanternScene, preloadLanternTextures } =
				await import('./landing-lantern-3d-scene.ts')
			await preloadLanternTextures()
			refreshFps = await fps
			if (signal.aborted || failed) return
			mountScene = mountLanternScene
			phase = 'mounting'
			handle.update()
		} catch {
			fail()
		}
	}

	const loader = ref((node: Element, signal: AbortSignal) => {
		const stop = observeNearViewport(node, () => void load(signal))
		signal.addEventListener('abort', stop)
	})

	function shown(figure: HTMLElement) {
		if (phase !== 'mounting') return
		// The still turns inert, so focus on one of its orbs moves to the
		// same orb in 3D.
		const focused = document.activeElement
		const id =
			focused instanceof HTMLElement && !figure.contains(focused)
				? focused.dataset.orb
				: undefined
		phase = 'fading'
		handle.update()
		if (id) {
			handle.queueTask(() => {
				figure
					.querySelector<HTMLElement>(`[data-orb="${id}"]`)
					?.focus({ preventScroll: true })
			})
		}
		fadeTimer = setTimeout(() => {
			fadeTimer = null
			if (phase !== 'fading') return
			phase = 'live'
			handle.update()
		}, fadeMs)
	}

	const stage = ref((node: Element, signal: AbortSignal) => {
		if (!(node instanceof HTMLElement)) return
		const canvas = node.querySelector('canvas')
		if (!canvas || !mountScene) return
		let scene: LanternScene | null = null
		signal.addEventListener('abort', () => {
			engine = null
			scene?.destroy()
		})
		mountScene(canvas, fail)
			.then((mounted) => {
				if (signal.aborted || failed) {
					mounted.destroy()
					return
				}
				scene = mounted
				engine = startLanternEngine({
					figure: node,
					scene: mounted,
					refreshFps,
					activeId: () => handle.props.activeId,
					onShown: () => shown(node),
					onFail: fail,
					onResolution(scale) {
						resolution = scale
						handle.update()
					},
					signal,
				})
			})
			.catch(fail)
	})

	function noticeActive(active: LandingPrimitiveId | null) {
		// A word opened while the scene loads waits for the engine, so the
		// lantern still turns to it once it is live.
		if (!engine || active === seenActive) return
		seenActive = active
		const fromLantern = active !== null && active === openedHere
		openedHere = null
		engine?.follow(fromLantern ? null : active)
		engine?.wake()
	}

	function leave(id: LandingPrimitiveId) {
		handle.props.onClose(id)
		handle.props.onResume(id)
	}

	function openHere(id: LandingPrimitiveId) {
		openedHere = id
		handle.props.onOpen(id)
	}

	function renderOrb(id: LandingPrimitiveId) {
		const { activeId, panelId } = handle.props
		const primitive = landingHomePrimitives.find((entry) => entry.id === id)
		if (!primitive) return null
		const open = activeId === id
		return (
			<button
				key={id}
				type="button"
				data-orb={id}
				data-open={open ? '' : undefined}
				aria-label={`${primitive.word} primitive`}
				aria-expanded={open ? 'true' : 'false'}
				aria-controls={panelId(id)}
				aria-describedby={panelId(id)}
				mix={[
					orbCss,
					on('pointerenter', (event: PointerEvent) => {
						if (!hoverPointer(event)) return
						// A spin or a toss slides orbs under a still pointer.
						if (engine?.busy()) return
						openHere(id)
					}),
					on('pointerleave', (event: PointerEvent) => {
						if (!hoverPointer(event)) return
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
					on('focusin', (event: FocusEvent) => {
						openHere(id)
						const target = event.currentTarget
						if (target instanceof Element && target.matches(':focus-visible')) {
							engine?.turnTo(id)
						}
					}),
					on('focusout', () => leave(id)),
					on('click', () => {
						openedHere = id
						handle.props.onToggle(id)
					}),
					on('keydown', (event: KeyboardEvent) => {
						if (event.key === 'Escape') {
							event.preventDefault()
							handle.props.onDismiss(id)
							return
						}
						const turn = arrowTurn(event.key)
						if (turn === null || !engine) return
						event.preventDefault()
						engine.nudge(turn)
					}),
				]}
			/>
		)
	}

	return () => {
		noticeActive(handle.props.activeId)
		const ready = phase === 'fading' || phase === 'live'
		const canvasScale =
			resolution < 1
				? {
						width: percent(resolution),
						height: percent(resolution),
						transform: `scale(${1 / resolution})`,
					}
				: undefined
		return (
			<div mix={[slotCss, loader]}>
				{phase !== 'still' ? (
					<figure
						class="landing-lantern"
						data-lantern-3d=""
						data-ready={ready ? '' : undefined}
						inert={ready ? undefined : true}
						mix={[figureCss, stage]}
					>
						<figcaption class="visually-hidden">
							A lantern holding six glowing orbs, one for each Kody primitive.
							Drag it to turn it, or drag an orb to toss it.
						</figcaption>
						<div aria-hidden="true" mix={viewCss}>
							<canvas mix={canvasCss} style={canvasScale} />
						</div>
						{ready ? (
							<>
								<span
									class="landing-lantern-art"
									aria-hidden="true"
									style={glassBox}
								/>
								<div mix={orbsCss}>{landingPrimitiveIds.map(renderOrb)}</div>
							</>
						) : null}
					</figure>
				) : null}
				{phase !== 'live' ? (
					<div inert={phase === 'fading' ? true : undefined}>
						<LandingLantern {...handle.props} />
					</div>
				) : null}
			</div>
		)
	}
}

function arrowTurn(key: string) {
	if (key === 'ArrowLeft') return -nudgeYaw
	if (key === 'ArrowRight') return nudgeYaw
	return null
}

/** One grid cell: during the crossfade the 3D figure sits over the still. */
const slotCss = css({
	display: 'grid',
	'& > *': { gridArea: '1 / 1' },
})

const figureCss = css({
	zIndex: 1,
	opacity: 0,
	cursor: 'grab',
	touchAction: 'pan-y pinch-zoom',
	userSelect: 'none',
	WebkitTapHighlightColor: 'transparent',
	transition: `opacity ${fadeMs}ms ease`,
	'&[data-ready]': { opacity: 1 },
	'&[data-grabbing]': { cursor: 'grabbing' },
	'@media (prefers-reduced-motion: reduce)': { transition: 'none' },
})

/** The canvas box overhangs the figure (see `lanternView`). Its edges fade
 *  out, so where it overlaps the heading or the page, they show through. */
const viewCss = css({
	position: 'absolute',
	left: percent(lanternView.left),
	top: percent(lanternView.top),
	width: percent(lanternView.size),
	height: percent(lanternView.size),
	zIndex: 0,
	overflow: 'hidden',
	pointerEvents: 'none',
	maskImage:
		'linear-gradient(to bottom, transparent, #000 5%, #000 97%, transparent), linear-gradient(to right, transparent, #000 4%, #000 96%, transparent)',
	maskComposite: 'intersect',
})

/** Adaptive resolution renders a smaller canvas and scales it back up. */
const canvasCss = css({
	position: 'absolute',
	left: 0,
	top: 0,
	display: 'block',
	width: '100%',
	height: '100%',
	transformOrigin: '0 0',
})

const orbsCss = css({
	position: 'absolute',
	inset: 0,
	zIndex: 2,
})

/** Invisible hotspots, moved every frame onto the painted orbs. */
const orbCss = css({
	position: 'absolute',
	left: 0,
	top: 0,
	width: '1px',
	height: '1px',
	margin: 0,
	padding: 0,
	border: 'none',
	borderRadius: '50%',
	background: 'transparent',
	cursor: 'grab',
	touchAction: 'none',
	willChange: 'transform',
	'&[data-grabbed]': { cursor: 'grabbing' },
})
