import {
	lanternOrbMotionEvent,
	lanternOrbReleaseEvent,
} from '#client/routes/landing-lantern-motion.ts'
import {
	createLanternOrbBodies,
	createLanternOrbit,
	createLanternResolution,
	createLanternWarmup,
	holdLanternOrbit,
	lanternFlickVelocity,
	lanternOrbRadius,
	lanternPitchLimit,
	lanternPose,
	lanternViewBasis,
	localToWorld,
	pokeLanternOrbs,
	projectLanternPoint,
	projectedSphereRadius,
	resumeLanternWarmup,
	screenDeltaToWorld,
	stepLanternOrbit,
	stepLanternOrbs,
	stepLanternResolution,
	stepLanternWarmup,
	turnLanternTo,
	worldToLocal,
	type LanternOrbBody,
	type LanternOrbHold,
	type LanternPointerSample,
	type Vec3,
} from '#client/routes/landing-lantern-3d-motion.ts'
import {
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * The live half of the 3D lantern: one frame loop that steps the orbit and
 * the orbs, writes them into the GSS scene as custom properties, and keeps
 * the HTML orb buttons on the painted orbs. Pointer gestures on the figure
 * turn the lantern (a flick keeps it spinning), toss an orb, or tap the
 * glass, which flares the light and knocks the orbs about.
 *
 * The first frames are a warm-up (`stepLanternWarmup`): only once the
 * scene keeps up does `onShown` crossfade it in. Otherwise `onSlow` hands
 * the page back to the still lantern.
 */

/** The canvas box, as fractions of the figure (same aspect ratio). It
 *  overhangs the lantern so a tilt and the halo are never clipped. */
export const lanternView = { left: -0.061, top: -0.083, size: 1.122 } as const

/** The globe's glow in landing-lantern-3d.gss; a tap flares both. */
const flameCore = '#fff1c2'
const flameAmber = '#ffb733'

const basis = lanternViewBasis()
const dragSlopPx = 8
const followDelayMs = 220
/** A drag across the whole lantern is half a turn. */
const yawPerWidth = Math.PI
const pitchPerHeight = Math.PI / 4
const maxSpin = 9
const flickWindowMs = 90
/** A lit orb's size springs past its target and back, like jelly. */
const jellyStiffness = 260
const jellyDamping = 14

export type LanternSceneView = {
	set(name: string, value: string | number): void
}

export type LanternEngine = {
	/** Props or focus changed outside the loop: draw a frame. */
	wake(): void
	/** Bring an orb round to face the camera. */
	turnTo(id: LandingPrimitiveId): void
	/** Turn toward an orb opened elsewhere (the word list), after a beat,
	 *  so sweeping across the words does not whip the lantern about. */
	follow(id: LandingPrimitiveId | null): void
	/** Arrow keys: turn and tilt by these angles, in radians. */
	nudge(yaw: number, pitch: number): void
	/** Orbs are moving under a still pointer, so hover is not intent. */
	busy(): boolean
}

type Gesture =
	| {
			kind: 'orbit'
			pointerId: number
			originX: number
			originY: number
			downAt: number
			moved: boolean
			baseYaw: number
			basePitch: number
			samples: Array<{ yaw: number; t: number }>
	  }
	| {
			kind: 'orb'
			pointerId: number
			id: LandingPrimitiveId
			button: HTMLElement
			originX: number
			originY: number
			downAt: number
			moved: boolean
			grab: Vec3
			depth: number
			samples: Array<LanternPointerSample>
	  }

export function startLanternEngine(options: {
	figure: HTMLElement
	scene: LanternSceneView
	refreshFps: number
	activeId: () => LandingPrimitiveId | null
	/** The scene drew its warm-up and keeps up. */
	onShown: () => void
	/** The warm-up was too slow: this device should keep the still. */
	onSlow: () => void
	/** Adaptive resolution picked a new share of the device pixel ratio. */
	onResolution: (scale: number) => void
	signal: AbortSignal
}): LanternEngine {
	const { figure, scene, signal } = options
	const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
	const narrow = matchMedia('(max-width: 800px)')
	const dark = matchMedia('(prefers-color-scheme: dark)')
	const buttons = new Map<LandingPrimitiveId, HTMLElement>()
	let orbit = createLanternOrbit()
	let bodies: Array<LanternOrbBody> = createLanternOrbBodies()
	let hold: LanternOrbHold | null = null
	let gesture: Gesture | null = null
	let resolution = createLanternResolution(
		options.refreshFps,
		window.devicePixelRatio || 1,
		performance.now(),
	)
	let warmup = createLanternWarmup(performance.now())
	let time = 0
	let last = performance.now()
	let poseYaw = 0
	let raf: number | null = null
	let framing = false
	let visible = true
	let frames = 0
	let flare = 0
	let followTimer: ReturnType<typeof setTimeout> | null = null
	let swallowClick = false
	let width = 0
	let height = 0
	const glow = perOrb(1)
	const grow = perOrb(1)
	const growVelocity = perOrb(0)
	const written = new Map<string, string | number>()

	const write = (name: string, value: string | number) => {
		const rounded =
			typeof value === 'number' ? Math.round(value * 10_000) / 10_000 : value
		if (written.get(name) === rounded) return
		written.set(name, rounded)
		scene.set(name, rounded)
	}

	const measure = () => {
		const rect = figure.getBoundingClientRect()
		width = rect.width
		height = rect.height
		for (const button of figure.querySelectorAll<HTMLElement>('[data-orb]')) {
			const id = button.dataset.orb as LandingPrimitiveId
			if (landingPrimitiveIds.includes(id)) buttons.set(id, button)
		}
	}

	const viewSize = () => ({
		left: width * lanternView.left,
		top: height * lanternView.top,
		width: width * lanternView.size,
		height: height * lanternView.size,
	})

	const writePage = () => {
		write('--page', pageColor(figure))
	}

	const ease = (from: number, to: number, dt: number, rate: number) =>
		motionOk.matches ? from + (to - from) * (1 - Math.exp(-dt * rate)) : to

	const frame = (now: number) => {
		raf = null
		framing = true
		const going = step(now)
		framing = false
		if (going && keepGoing()) schedule()
	}

	/** One frame. False once the warm-up gave up on this device. */
	const step = (now: number) => {
		// The orb buttons render once the scene has shown its first frames.
		if (width === 0 || buttons.size < landingPrimitiveIds.length) measure()
		const dt = Math.min(Math.max((now - last) / 1000, 0), 1 / 30)
		last = now
		const motion = motionOk.matches
		if (motion) time += dt
		const held = gesture?.moved === true
		orbit = stepLanternOrbit(orbit, dt, { held, motion })
		const pose = lanternPose(orbit, time)
		const spin = pose.yaw - poseYaw
		poseYaw = pose.yaw
		const active = options.activeId()
		const grabbed = held && gesture?.kind === 'orb' ? gesture.id : null
		flare = motion ? flare * Math.exp(-dt * 2.2) : 0
		if (flare < 0.002) flare = 0
		for (const id of landingPrimitiveIds) {
			const lit = id === grabbed || id === active
			const glowTarget = (lit ? 1.35 : active ? 0.7 : 1) + flare * 0.3
			glow[id] = ease(glow[id], glowTarget, dt, 9)
			const growTarget = id === grabbed ? 1.24 : lit ? 1.18 : 1
			if (motion) {
				growVelocity[id] +=
					(jellyStiffness * (growTarget - grow[id]) -
						jellyDamping * growVelocity[id]) *
					dt
				grow[id] += growVelocity[id] * dt
			} else {
				grow[id] = growTarget
				growVelocity[id] = 0
			}
		}
		// Without motion only a held orb leaves home, so reduced motion
		// turned on mid-toss sends every orb straight back.
		bodies =
			motion || hold
				? stepLanternOrbs(bodies, dt, {
						time,
						amplitude: motion ? (narrow.matches ? 0.62 : 1) : 0,
						spin,
						hold,
					})
				: createLanternOrbBodies()
		write('--yaw', `${pose.yaw}rad`)
		write('--pitch', `${pose.pitch}rad`)
		const flame = motion ? flicker(time) : 0
		write('--core', mixHex(flameCore, '#ffffff', flare * 0.7 + flame * 0.16))
		write('--amber', mixHex(flameAmber, '#ffe3a1', flare * 0.85 + flame * 0.1))
		// Through the warm-up, a change GSS cannot skip makes it draw every
		// frame, even under reduced motion, where nothing else moves.
		const probe = warmup.stage === 'done' ? 0 : (frames % 2) * 0.001
		write('--sparkle', 2.6 + flare * 2.4 + probe)
		const box = viewSize()
		const depths: Array<{ id: LandingPrimitiveId; depth: number }> = []
		for (const body of bodies) {
			body.scale = grow[body.id]
			const world = localToWorld(body.position, pose.yaw, pose.pitch)
			write(`--${body.id}-x`, world.x)
			write(`--${body.id}-y`, world.y)
			write(`--${body.id}-z`, world.z)
			write(`--${body.id}-scale`, body.scale)
			// Idle orbs breathe, staggered, as the 2D orbs pulse.
			const breath =
				motion && !active ? 1 + 0.07 * Math.sin(time * 1.8 + body.phase) : 1
			write(`--${body.id}-glow`, glow[body.id] * breath)
			const button = buttons.get(body.id)
			if (!button || box.height === 0) continue
			const point = projectLanternPoint(basis, world, box)
			const radius = projectedSphereRadius(
				basis,
				world,
				lanternOrbRadius * body.scale,
				box.height,
			)
			const x = box.left + point.x - radius
			const y = box.top + point.y - radius
			button.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
			button.style.width = `${(radius * 2).toFixed(1)}px`
			button.style.height = button.style.width
			depths.push({ id: body.id, depth: point.depth })
		}
		depths.sort((a, b) => b.depth - a.depth)
		depths.forEach(({ id }, index) => {
			const button = buttons.get(id)
			if (button) button.style.zIndex = String(index + 1)
		})
		figure.dispatchEvent(
			new CustomEvent(lanternOrbMotionEvent, { bubbles: true }),
		)
		frames += 1
		if (warmup.stage === 'done') {
			const nextResolution = stepLanternResolution(resolution, now)
			if (nextResolution.scale !== resolution.scale) {
				options.onResolution(nextResolution.scale)
			}
			resolution = nextResolution
			return true
		}
		const warm = stepLanternWarmup(warmup, now)
		warmup = warm.state
		switch (warm.verdict) {
			case 'wait':
				return true
			case 'lower':
				resolution = { ...resolution, scale: resolution.floor }
				options.onResolution(resolution.scale)
				return true
			case 'show':
				resolution = {
					...createLanternResolution(
						options.refreshFps,
						window.devicePixelRatio || 1,
						now,
					),
					scale: resolution.scale,
				}
				options.onShown()
				return true
			case 'slow':
				options.onSlow()
				return false
			default: {
				const unhandled: never = warm.verdict
				throw new Error(`Unknown warm-up verdict: ${String(unhandled)}`)
			}
		}
	}

	const keepGoing = () => {
		if (!visible || document.visibilityState === 'hidden') return false
		if (warmup.stage !== 'done' || gesture !== null) return true
		// A still lantern (reduced motion) has to place its buttons once.
		if (buttons.size < landingPrimitiveIds.length) return true
		if (motionOk.matches) return true
		return orbit.yawTarget !== null
	}

	const schedule = () => {
		if (raf == null) raf = requestAnimationFrame(frame)
	}

	/** Restart a stopped loop. A pause is not a slow frame to the warm-up. */
	const wake = () => {
		if (raf != null || framing) return
		last = performance.now()
		warmup = resumeLanternWarmup(warmup, last)
		schedule()
	}

	const bodyOf = (id: LandingPrimitiveId) =>
		bodies.find((body) => body.id === id)

	const turnTo = (id: LandingPrimitiveId) => {
		const body = bodyOf(id)
		if (!body || gesture !== null) return
		orbit = turnLanternTo(orbit, time, body.position)
		wake()
	}

	const poseNow = () => lanternPose(orbit, time)

	const onPointerDown = (event: PointerEvent) => {
		if (gesture !== null || event.button !== 0) return
		if (!(event.target instanceof Element)) return
		swallowClick = false
		measure()
		const button = event.target.closest<HTMLElement>('[data-orb]')
		const id = button?.dataset.orb as LandingPrimitiveId | undefined
		const base = {
			pointerId: event.pointerId,
			originX: event.clientX,
			originY: event.clientY,
			downAt: performance.now(),
			moved: false,
		}
		if (button && id && figure.contains(button) && bodyOf(id)) {
			gesture = {
				...base,
				kind: 'orb',
				id,
				button,
				grab: { x: 0, y: 0, z: 0 },
				depth: 1,
				samples: [],
			}
			capture(button, event.pointerId)
		} else {
			gesture = {
				...base,
				kind: 'orbit',
				baseYaw: 0,
				basePitch: 0,
				samples: [],
			}
			capture(figure, event.pointerId)
		}
	}

	/** The drag is measured from where the pointer went down, and the first
	 *  sample is that moment, so a flick of one or two moves still spins. */
	const beginDrag = (current: Gesture, event: PointerEvent) => {
		current.moved = true
		orbit = holdLanternOrbit(orbit, time)
		figure.dataset.grabbing = ''
		document.documentElement.style.cursor = 'grabbing'
		if (current.kind === 'orbit') {
			current.baseYaw = orbit.yaw
			current.basePitch = orbit.pitch
			current.samples.push({ yaw: orbit.yaw, t: current.downAt })
			return
		}
		const body = bodyOf(current.id)
		if (!body) return
		const pose = poseNow()
		current.grab = localToWorld(body.position, pose.yaw, pose.pitch)
		current.depth = projectLanternPoint(basis, current.grab, viewSize()).depth
		current.samples.push({ position: { ...body.position }, t: current.downAt })
		current.button.dataset.grabbed = ''
		// A touch drag focuses the orb and would leave the bottom sheet
		// open after the toss. A tap still focuses and toggles.
		if (event.pointerType === 'touch') current.button.blur()
	}

	const onPointerMove = (event: PointerEvent) => {
		const current = gesture
		if (!current || event.pointerId !== current.pointerId) return
		const dx = event.clientX - current.originX
		const dy = event.clientY - current.originY
		if (!current.moved) {
			if (Math.hypot(dx, dy) < dragSlopPx) return
			beginDrag(current, event)
		}
		if (event.cancelable) event.preventDefault()
		const now = performance.now()
		if (current.kind === 'orbit') {
			const yaw = current.baseYaw + (dx / Math.max(width, 1)) * yawPerWidth
			const raw =
				current.basePitch - (dy / Math.max(height, 1)) * pitchPerHeight
			orbit = {
				...orbit,
				yaw,
				pitch: lanternPitchLimit * Math.tanh(raw / lanternPitchLimit),
			}
			current.samples.push({ yaw, t: now })
			if (current.samples.length > 12) current.samples.shift()
		} else {
			const delta = screenDeltaToWorld(
				basis,
				dx,
				dy,
				current.depth,
				viewSize().height,
			)
			const pose = poseNow()
			const position = worldToLocal(
				{
					x: current.grab.x + delta.x,
					y: current.grab.y + delta.y,
					z: current.grab.z + delta.z,
				},
				pose.yaw,
				pose.pitch,
			)
			current.samples.push({ position, t: now })
			if (current.samples.length > 12) current.samples.shift()
			hold = {
				id: current.id,
				position,
				velocity: lanternFlickVelocity(current.samples, now),
			}
		}
		wake()
	}

	const endGesture = (event: PointerEvent, flick: boolean) => {
		const current = gesture
		if (!current || event.pointerId !== current.pointerId) return
		gesture = null
		delete figure.dataset.grabbing
		document.documentElement.style.cursor = ''
		const motion = motionOk.matches
		if (!current.moved) {
			if (current.kind === 'orbit' && flick && motion) {
				bodies = pokeLanternOrbs(bodies)
				flare = 1
			}
			wake()
			return
		}
		swallowClick = true
		requestAnimationFrame(() => {
			swallowClick = false
		})
		if (current.kind === 'orbit') {
			const spin = flick && motion ? yawFlick(current.samples) : 0
			orbit = { ...orbit, yawVelocity: spin }
		} else {
			delete current.button.dataset.grabbed
			const velocity =
				flick && motion
					? lanternFlickVelocity(current.samples, performance.now())
					: { x: 0, y: 0, z: 0 }
			if (motion && hold) {
				bodies = stepLanternOrbs(bodies, 0, {
					time,
					amplitude: 1,
					hold: { ...hold, velocity },
				})
			} else if (!motion) {
				bodies = createLanternOrbBodies()
			}
			hold = null
			current.button.dispatchEvent(new Event(lanternOrbReleaseEvent))
		}
		wake()
	}

	figure.addEventListener('pointerdown', onPointerDown, { signal })
	figure.addEventListener(
		'click',
		(event) => {
			if (!swallowClick) return
			swallowClick = false
			event.preventDefault()
			event.stopPropagation()
		},
		{ capture: true, signal },
	)
	window.addEventListener('pointermove', onPointerMove, { signal })
	window.addEventListener('pointerup', (event) => endGesture(event, true), {
		signal,
	})
	window.addEventListener(
		'pointercancel',
		(event) => endGesture(event, false),
		{ signal },
	)

	const resize = new ResizeObserver(() => {
		measure()
		wake()
	})
	resize.observe(figure)
	const sight = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true
		wake()
	})
	sight.observe(figure)
	motionOk.addEventListener('change', wake, { signal })
	narrow.addEventListener('change', wake, { signal })
	dark.addEventListener(
		'change',
		() => {
			writePage()
			wake()
		},
		{ signal },
	)
	document.addEventListener('visibilitychange', wake, { signal })
	signal.addEventListener('abort', () => {
		resize.disconnect()
		sight.disconnect()
		if (raf != null) cancelAnimationFrame(raf)
		if (followTimer != null) clearTimeout(followTimer)
		if (figure.dataset.grabbing != null) {
			document.documentElement.style.cursor = ''
		}
	})

	measure()
	writePage()
	wake()

	return {
		wake,
		turnTo(id) {
			if (!motionOk.matches) return
			turnTo(id)
		},
		follow(id) {
			if (followTimer != null) clearTimeout(followTimer)
			followTimer = null
			if (!id || !motionOk.matches) return
			followTimer = setTimeout(() => {
				followTimer = null
				turnTo(id)
			}, followDelayMs)
		},
		nudge(yaw, pitch) {
			if (gesture !== null) return
			const pose = poseNow()
			const held = holdLanternOrbit(orbit, time)
			orbit = {
				...held,
				yawTarget: (orbit.yawTarget ?? pose.yaw) + yaw,
				pitchRest: Math.max(
					-lanternPitchLimit,
					Math.min(lanternPitchLimit, held.pitchRest + pitch),
				),
			}
			wake()
		},
		busy() {
			if (gesture !== null) return true
			if (orbit.yawTarget !== null) return true
			if (Math.abs(orbit.yawVelocity) > 0.6) return true
			return bodies.some((body) => body.coasting)
		},
	}
}

/** How long the display takes per frame, measured before the scene draws. */
export function measureRefreshFps(signal: AbortSignal): Promise<number> {
	return new Promise((resolve) => {
		const stamps: Array<number> = []
		let raf = 0
		const done = () => {
			cancelAnimationFrame(raf)
			const gaps = stamps
				.slice(1)
				.map((stamp, index) => stamp - stamps[index]!)
				.sort((a, b) => a - b)
			const median = gaps[Math.floor(gaps.length / 2)]
			resolve(median ? 1000 / median : 60)
		}
		const tick = (now: number) => {
			stamps.push(now)
			if (stamps.length >= 16 || signal.aborted) return done()
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		setTimeout(done, 1000)
	})
}

function perOrb(value: number) {
	return Object.fromEntries(
		landingPrimitiveIds.map((id) => [id, value]),
	) as Record<LandingPrimitiveId, number>
}

/** A candle's unsteady glow, 0 to 1: sines that never line up. */
function flicker(time: number) {
	const wave =
		Math.sin(time * 1.7) * 0.5 +
		Math.sin(time * 2.9 + 1.3) * 0.3 +
		Math.sin(time * 5.3 + 0.4) * 0.2
	return 0.5 + wave * 0.5
}

function capture(element: Element, pointerId: number) {
	try {
		element.setPointerCapture(pointerId)
	} catch {
		// The pointer can already be gone. Window listeners still end it.
	}
}

function yawFlick(samples: ReadonlyArray<{ yaw: number; t: number }>) {
	const now = performance.now()
	const recent = samples.filter((sample) => now - sample.t <= flickWindowMs)
	const first = recent[0]
	const last = recent.at(-1)
	if (!first || !last || last.t - first.t < 12) return 0
	const speed = ((last.yaw - first.yaw) / (last.t - first.t)) * 1000
	return Math.max(-maxSpin, Math.min(maxSpin, speed))
}

/** The page color behind the figure, so the scene's edge disappears. */
function pageColor(node: Element) {
	for (let el: Element | null = node; el; el = el.parentElement) {
		const color = getComputedStyle(el).backgroundColor
		if (color && !isClear(color)) return color
	}
	return '#e6e8ea'
}

function isClear(color: string) {
	return (
		color === 'transparent' ||
		/rgba\([^)]*,\s*0\)$/.test(color) ||
		/\/\s*0\)$/.test(color)
	)
}

function mixHex(from: string, to: string, amount: number) {
	const t = Math.min(Math.max(amount, 0), 1)
	if (t === 0) return from
	const a = hexChannels(from)
	const b = hexChannels(to)
	return `#${a
		.map((channel, index) =>
			Math.round(channel + (b[index]! - channel) * t)
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`
}

function hexChannels(hex: string) {
	return [1, 3, 5].map((start) =>
		Number.parseInt(hex.slice(start, start + 2), 16),
	)
}
