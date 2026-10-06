/**
 * Whether and when the homepage may start the 3D lantern. The 2D lantern
 * stays without WebGL2 in a worker and with Save-Data.
 */

/** WebGL2 (three.js needs it), a canvas a worker can draw on, and no
 *  Save-Data request. */
export function lantern3dAllowed() {
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
