import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'

/**
 * Whether and when the homepage may start the 3D lantern. The 2D lantern
 * stays without WebGL2 in a worker, with Save-Data, and for the rest of
 * the tab's visit once WebGL here turned out to run without a GPU or the
 * 3D lantern's first second ran too slow.
 */

/** Why this tab keeps the 2D lantern. */
type Lantern3dDecline = 'no-gpu' | 'slow'

const declinedKey = 'kody.lantern3dDeclined'

export function lantern3dAllowed() {
	return supports3d() && getSessionStorageItem(declinedKey) === null
}

/** Keeps the 2D lantern for the rest of this tab's visit. Without storage,
 *  the next homepage visit asks again. */
export function declineLantern3d(reason: Lantern3dDecline) {
	setSessionStorageItem(declinedKey, reason)
}

/** WebGL2 (three.js needs it), a canvas a worker can draw on, and no
 *  Save-Data request. */
function supports3d() {
	if (typeof WebGL2RenderingContext === 'undefined') return false
	if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') {
		return false
	}
	if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) {
		return false
	}
	const connection: { saveData?: boolean } | undefined = Reflect.get(
		navigator,
		'connection',
	)
	return connection?.saveData !== true
}

/** Off the critical path: let the page settle before starting a worker. */
export function whenIdle(task: () => void) {
	if ('requestIdleCallback' in window) {
		window.requestIdleCallback(task, { timeout: 1500 })
	} else {
		setTimeout(task, 120)
	}
}
