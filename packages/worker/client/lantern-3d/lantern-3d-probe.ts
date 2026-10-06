import { type LanternProbeMessage } from './lantern-3d-protocol.ts'

/**
 * A throwaway worker that only asks whether WebGL here runs on a GPU. On a
 * software rasterizer the 3D lantern would spend whole CPU cores on every
 * frame, so the page keeps the 2D lantern and never starts the scene's
 * worker (or fetches three.js).
 */

type ProbeScope = { postMessage: (message: LanternProbeMessage) => void }

const scope: ProbeScope = self

/** Software rasterizers seen in the wild: Chrome's, Mesa's, and Windows'. */
const softwareRenderer = /swiftshader|llvmpipe|softpipe|basic render|software/i

/** Some browsers refuse a context that asks to fail on a major
 *  performance caveat when WebGL would run on the CPU; others only say so
 *  in the renderer's name. */
function drawsOnGpu() {
	try {
		const gl = new OffscreenCanvas(1, 1).getContext('webgl2', {
			failIfMajorPerformanceCaveat: true,
		})
		if (!gl) return false
		const info = gl.getExtension('WEBGL_debug_renderer_info')
		const name: unknown = gl.getParameter(
			info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
		)
		gl.getExtension('WEBGL_lose_context')?.loseContext()
		return !(typeof name === 'string' && softwareRenderer.test(name))
	} catch {
		return false
	}
}

scope.postMessage({ type: 'probe', gpu: drawsOnGpu() })
