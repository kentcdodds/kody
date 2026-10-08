import { type LanternStep } from './lantern-3d-model.ts'
import {
	type LanternHostMessage,
	type LanternWorkerMessage,
} from './lantern-3d-protocol.ts'
import { createLanternScene, type LanternScene } from './lantern-3d-scene.ts'

/**
 * The 3D lantern's own thread. The page transfers its canvas here and
 * forwards sizes, colors, and pointer input, so three.js, the shaders, and
 * every frame stay off the page's main thread, which a machine without a
 * GPU needs most.
 *
 * Startup runs one small step at a time at background priority, so any
 * message the page sent goes first. While the page navigates, startup
 * stops before its next step and no frames draw. The first second of
 * frames then draws behind the 2D lantern, and only if it ran fast enough
 * does the page get `ready`; otherwise the scene stops and the page keeps
 * the 2D lantern. The page terminates the worker when the lantern leaves.
 */

type WorkerScope = {
	postMessage: (message: LanternWorkerMessage) => void
	addEventListener: (
		type: 'message',
		listener: (event: MessageEvent<LanternHostMessage>) => void,
	) => void
}

const scope: WorkerScope = self

let scene: LanternScene | null = null
let paused = false
let visible = false
const resumes: Array<() => void> = []
/** Messages from before the scene was ready, applied once it is. */
const early: Array<LanternHostMessage> = []

scope.addEventListener('message', (event) => receive(event.data))

function receive(message: LanternHostMessage) {
	if (message.type === 'start') {
		void start(message)
		return
	}
	if (message.type === 'pause') {
		paused = message.paused
		if (!paused) {
			for (const resume of resumes.splice(0)) resume()
		}
	}
	if (message.type === 'visible') visible = message.visible
	if (scene) apply(scene, message)
	else early.push(message)
}

async function start(message: Extract<LanternHostMessage, { type: 'start' }>) {
	paused = message.paused
	visible = message.visible
	try {
		const created = await createLanternScene({
			canvas: message.canvas,
			viewport: message.viewport,
			palette: message.palette,
			motion: message.motion,
			orbs: message.orbs,
			step,
			onFrame: (frame) => scope.postMessage({ type: 'frame', frame }),
			onLost: () => scope.postMessage({ type: 'failed' }),
		})
		scene = created
		for (const queued of early.splice(0)) apply(created, queued)
		const speed = created.trial()
		created.setVisible(visible && !paused)
		if ((await speed) === 'slow') {
			scene = null
			created.dispose()
			scope.postMessage({ type: 'slow' })
			return
		}
		scope.postMessage({ type: 'ready', frame: created.frame() })
	} catch {
		scope.postMessage({ type: 'failed' })
	}
}

const step: LanternStep = async (work) => {
	while (paused) await new Promise<void>((resume) => resumes.push(resume))
	const result = await work()
	await afterQueuedMessages()
	return result
}

/** A background task runs after every message already queued, so a pause
 *  that lands mid-startup holds the next step. */
function afterQueuedMessages() {
	const scheduler: unknown = Reflect.get(globalThis, 'scheduler')
	if (
		typeof scheduler === 'object' &&
		scheduler !== null &&
		'postTask' in scheduler &&
		typeof scheduler.postTask === 'function'
	) {
		return Promise.resolve(
			scheduler.postTask(() => {}, { priority: 'background' }),
		).then(() => undefined)
	}
	return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function apply(live: LanternScene, message: LanternHostMessage) {
	switch (message.type) {
		case 'start':
			return
		case 'layout':
			live.layout(message.viewport)
			return
		case 'poster':
			scope.postMessage({
				type: 'matched',
				frame: live.matchPoster(message.orbs),
			})
			return
		case 'palette':
			live.setPalette(message.palette)
			return
		case 'motion':
			live.setMotion(message.motion)
			return
		case 'visible':
		case 'pause':
			live.setVisible(visible && !paused)
			return
		case 'active':
			live.setActive(message.id)
			return
		case 'celebrate':
			live.celebrate(message.id)
			return
		case 'nudge':
			live.nudge()
			return
		case 'spin':
			live.spin(message.direction, message.big)
			return
		case 'turn-start':
			live.beginTurn(message.x, message.y, message.t)
			return
		case 'turn':
			live.turn(message.x, message.y, message.t)
			return
		case 'turn-end':
			live.endTurn(message.flick, message.t)
			return
		case 'grab':
			live.grabOrb(message.id, message.x, message.y, message.t)
			return
		case 'drag':
			live.moveOrb(message.x, message.y, message.t)
			return
		case 'drop':
			live.releaseOrb(message.flick, message.t)
			return
		case 'look':
			live.look(message.x, message.y)
			return
		case 'look-away':
			live.stopLooking()
			return
		default: {
			const exhaustive: never = message
			return exhaustive
		}
	}
}
