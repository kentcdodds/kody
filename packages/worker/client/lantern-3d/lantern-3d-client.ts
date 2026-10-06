import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import {
	lanternFlickVelocity,
	type LanternPointerSample3d,
} from './lantern-3d-motion.ts'
import {
	type LanternHostMessage,
	type LanternMotion,
	type LanternPalette,
	type LanternPoint,
	type LanternProbeMessage,
	type LanternSceneFrame,
	type LanternViewport,
	type LanternWorkerMessage,
} from './lantern-3d-protocol.ts'

/**
 * The page's side of the 3D lantern. It starts the lantern's worker, hands
 * it the canvas, and passes page events along in canvas pixels. The worker
 * answers each frame with where the orbs project. Nothing here loads
 * three.js: that lives in the worker's own bundle.
 */

type LanternGpuProbe = 'gpu' | 'no-gpu' | 'unknown'

/** Asks a throwaway worker whether WebGL here runs on a GPU. A probe that
 *  never answers (its chunk failed to load, say) says nothing about the
 *  GPU, so it comes back `unknown`. */
export function probeLanternGpu() {
	return new Promise<LanternGpuProbe>((resolve) => {
		const probe = new Worker(
			new URL('./lantern-3d-probe.ts', import.meta.url),
			{ type: 'module', name: 'lantern-3d-probe' },
		)
		const answer = (verdict: LanternGpuProbe) => {
			probe.terminate()
			resolve(verdict)
		}
		probe.addEventListener(
			'message',
			(event: MessageEvent<LanternProbeMessage>) =>
				answer(event.data.gpu ? 'gpu' : 'no-gpu'),
		)
		probe.addEventListener('error', () => answer('unknown'))
		probe.addEventListener('messageerror', () => answer('unknown'))
	})
}

export type LanternClientOptions = {
	canvas: HTMLCanvasElement
	/** The lantern's layout box, where the 2D still sits. */
	frame: HTMLElement
	palette: LanternPalette
	motion: LanternMotion
	/** The 2D orbs, in frame pixels, for the first frame to match. */
	orbs: ReadonlyArray<LanternPoint>
	visible: boolean
	paused: boolean
	onFrame: (frame: LanternSceneFrame) => void
	/** The GPU context was lost after startup. */
	onLost: () => void
}

export type LanternClient = {
	/** Resolves once the first second has drawn (hidden): `slow` when it
	 *  ran too slow to show. Rejects if startup fails. */
	ready: Promise<'fast' | 'slow'>
	/** Puts the 3D orbs where the 2D ones are now. Resolves once that
	 *  frame has drawn. */
	matchPoster: (orbs: ReadonlyArray<LanternPoint>) => Promise<void>
	layout: () => void
	setActive: (id: LandingPrimitiveId | null) => void
	setPalette: (palette: LanternPalette) => void
	setMotion: (motion: LanternMotion) => void
	setVisible: (visible: boolean) => void
	/** Hold startup and frames while the page navigates. */
	pause: (paused: boolean) => void
	celebrate: (id: LandingPrimitiveId) => void
	/** A tap on the lantern itself. */
	nudge: () => void
	/** Keyboard and button turns: -1 or 1, with a flourish for `big`. */
	spin: (direction: number, big?: boolean) => void
	beginTurn: (clientX: number, clientY: number) => void
	turn: (clientX: number, clientY: number) => void
	endTurn: (flick: boolean) => void
	grabOrb: (id: LandingPrimitiveId, clientX: number, clientY: number) => void
	moveOrb: (clientX: number, clientY: number) => void
	/** True when the orb flies off, so the page can hold its hover shut. */
	releaseOrb: (flick: boolean) => boolean
	look: (clientX: number, clientY: number) => void
	stopLooking: () => void
	dispose: () => void
}

export function createLanternClient(
	options: LanternClientOptions,
): LanternClient {
	const { canvas, frame } = options
	const worker = new Worker(
		new URL('./lantern-3d-worker.ts', import.meta.url),
		{ type: 'module', name: 'lantern-3d' },
	)
	let motion = options.motion
	let disposed = false
	let started = false
	/** The held orb's recent pointer positions, to tell a toss from a drop. */
	let samples: Array<LanternPointerSample3d> = []
	let settle: {
		resolve: (speed: 'fast' | 'slow') => void
		reject: (error: Error) => void
	} | null = null
	const ready = new Promise<'fast' | 'slow'>((resolve, reject) => {
		settle = { resolve, reject }
	})
	let matched: (() => void) | null = null

	function fail() {
		if (disposed) return
		if (!started) {
			settle?.reject(new Error('The 3D lantern could not start.'))
			return
		}
		options.onLost()
	}

	worker.addEventListener(
		'message',
		(event: MessageEvent<LanternWorkerMessage>) => {
			if (disposed) return
			const message = event.data
			switch (message.type) {
				case 'ready':
					started = true
					options.onFrame(message.frame)
					settle?.resolve('fast')
					return
				case 'slow':
					settle?.resolve('slow')
					return
				case 'frame':
					options.onFrame(message.frame)
					return
				case 'matched':
					options.onFrame(message.frame)
					matched?.()
					matched = null
					return
				case 'failed':
					fail()
					return
				default: {
					const exhaustive: never = message
					return exhaustive
				}
			}
		},
	)
	worker.addEventListener('error', fail)
	worker.addEventListener('messageerror', fail)

	function post(
		message: LanternHostMessage,
		transfer: Array<Transferable> = [],
	) {
		if (!disposed) worker.postMessage(message, transfer)
	}

	function viewport(): LanternViewport {
		const box = canvas.getBoundingClientRect()
		const lantern = frame.getBoundingClientRect()
		return {
			width: box.width,
			height: box.height,
			frame: {
				left: lantern.left - box.left,
				top: lantern.top - box.top,
				width: lantern.width,
				height: lantern.height,
			},
			devicePixelRatio: window.devicePixelRatio,
		}
	}

	function local(clientX: number, clientY: number) {
		const box = canvas.getBoundingClientRect()
		return { x: clientX - box.left, y: clientY - box.top, t: performance.now() }
	}

	const offscreen = canvas.transferControlToOffscreen()
	post(
		{
			type: 'start',
			canvas: offscreen,
			viewport: viewport(),
			palette: options.palette,
			motion,
			orbs: options.orbs,
			visible: options.visible,
			paused: options.paused,
		},
		[offscreen],
	)

	return {
		ready,
		matchPoster(orbs) {
			return new Promise<void>((resolve) => {
				matched = resolve
				post({ type: 'poster', orbs })
			})
		},
		layout: () => post({ type: 'layout', viewport: viewport() }),
		setActive: (id) => post({ type: 'active', id }),
		setPalette: (palette) => post({ type: 'palette', palette }),
		setMotion(next) {
			motion = next
			post({ type: 'motion', motion: next })
		},
		setVisible: (visible) => post({ type: 'visible', visible }),
		pause: (paused) => post({ type: 'pause', paused }),
		celebrate: (id) => post({ type: 'celebrate', id }),
		nudge: () => post({ type: 'nudge' }),
		spin: (direction, big = false) => post({ type: 'spin', direction, big }),
		beginTurn: (clientX, clientY) =>
			post({ type: 'turn-start', ...local(clientX, clientY) }),
		turn: (clientX, clientY) =>
			post({ type: 'turn', ...local(clientX, clientY) }),
		endTurn: (flick) => post({ type: 'turn-end', flick, t: performance.now() }),
		grabOrb(id, clientX, clientY) {
			const at = local(clientX, clientY)
			samples = [{ ...at, z: 0 }]
			post({ type: 'grab', id, ...at })
		},
		moveOrb(clientX, clientY) {
			const at = local(clientX, clientY)
			samples.push({ ...at, z: 0 })
			if (samples.length > 12) samples.shift()
			post({ type: 'drag', ...at })
		},
		releaseOrb(flick) {
			const t = performance.now()
			const velocity =
				flick && !motion.reduced
					? lanternFlickVelocity(samples, t)
					: { vx: 0, vy: 0, vz: 0 }
			samples = []
			post({ type: 'drop', flick, t })
			return Math.hypot(velocity.vx, velocity.vy) > 0
		},
		look(clientX, clientY) {
			const { x, y } = local(clientX, clientY)
			post({ type: 'look', x, y })
		},
		stopLooking: () => post({ type: 'look-away' }),
		dispose() {
			disposed = true
			worker.terminate()
		},
	}
}
