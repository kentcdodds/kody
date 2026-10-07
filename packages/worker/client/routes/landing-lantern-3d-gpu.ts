/**
 * Whether this device should try the 3D lantern at all. three.js draws it
 * with WebGL2 into half-float targets, so the browser has to hand out a
 * WebGL2 context that can render to them. A software renderer
 * (SwiftShader, llvmpipe, WARP) draws the scene at a frame or two a
 * second, so it keeps the still lantern. The engine's warm-up backs this
 * up for hardware that is simply too slow.
 */

const softwareRenderer =
	/swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic render|mesa offscreen/i

/** A WebGL renderer name that is a software rasterizer. */
export function isSoftwareRenderer(name: string) {
	return softwareRenderer.test(name)
}

export function hasLanternGpu() {
	// The browser itself turns this down for a software or blocklisted GPU.
	const gl = document
		.createElement('canvas')
		.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
	if (!gl) return false
	try {
		const halfFloatTargets =
			gl.getExtension('EXT_color_buffer_float') ??
			gl.getExtension('EXT_color_buffer_half_float')
		if (!halfFloatTargets) return false
		return !isSoftwareRenderer(rendererName(gl))
	} finally {
		gl.getExtension('WEBGL_lose_context')?.loseContext()
	}
}

/** Chrome and Safari mask RENDERER behind the debug extension. Firefox
 *  names the GPU there and warns when the extension is asked for. */
function rendererName(gl: WebGL2RenderingContext) {
	const named = String(gl.getParameter(gl.RENDERER) ?? '')
	if (named && !/^webkit webgl$/i.test(named)) return named
	const debug = gl.getExtension('WEBGL_debug_renderer_info')
	return debug
		? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? '')
		: named
}
