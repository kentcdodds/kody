/**
 * Whether this device should try the 3D lantern at all. A software renderer
 * (SwiftShader, llvmpipe, WARP) raymarches the scene at a frame or two a
 * second, so it keeps the still lantern, as does a browser with neither
 * WebGPU nor WebGL2. GSS draws with WebGPU when the browser hands it an
 * adapter and falls back to WebGL2, so the check goes in the same order.
 * The engine's warm-up backs this up for hardware that is simply too slow.
 */

const softwareRenderer =
	/swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic render|mesa offscreen/i

/** A GPU adapter or WebGL renderer name that is a software rasterizer. */
export function isSoftwareRenderer(name: string) {
	return softwareRenderer.test(name)
}

export async function hasLanternGpu() {
	const adapter = await webgpuAdapter()
	if (adapter) {
		const info = 'info' in adapter ? adapter.info : null
		if (!info) return true
		if (info.isFallbackAdapter) return false
		return !isSoftwareRenderer(
			[info.vendor, info.architecture, info.device, info.description].join(' '),
		)
	}
	return hasWebgl2Gpu()
}

async function webgpuAdapter() {
	if (!('gpu' in navigator)) return null
	try {
		return await navigator.gpu.requestAdapter()
	} catch {
		return null
	}
}

function hasWebgl2Gpu() {
	// The browser itself turns this down for a software or blocklisted GPU.
	const gl = document
		.createElement('canvas')
		.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
	if (!gl) return false
	try {
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
