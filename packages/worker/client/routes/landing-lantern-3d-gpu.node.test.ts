import { afterEach, expect, test, vi } from 'vitest'
import { hasLanternGpu, isSoftwareRenderer } from './landing-lantern-3d-gpu.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubWebgl(
	context: {
		renderer: string
		unmasked?: string
		/** The float color extensions the context offers. */
		floatColor?: Array<string>
	} | null,
) {
	const requests: Array<unknown> = []
	let lost = false
	const floatColor = context?.floatColor ?? ['EXT_color_buffer_float']
	const gl = context && {
		RENDERER: 0x1f01,
		getParameter(name: number) {
			if (name === 0x1f01) return context.renderer
			if (name === 0x9246) return context.unmasked ?? null
			return null
		},
		getExtension(name: string) {
			if (name === 'WEBGL_debug_renderer_info') {
				return context.unmasked ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null
			}
			if (name === 'WEBGL_lose_context') {
				return {
					loseContext: () => {
						lost = true
					},
				}
			}
			return floatColor.includes(name) ? {} : null
		},
	}
	vi.stubGlobal('document', {
		createElement: () => ({
			getContext: (type: string, options: unknown) => {
				requests.push({ type, options })
				return gl
			},
		}),
	})
	return { requests, lost: () => lost }
}

test('software rasterizers are told apart from GPUs by name', () => {
	const software = [
		'Google SwiftShader',
		'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
		'llvmpipe (LLVM 15.0.7, 256 bits)',
		'ANGLE (Mesa, llvmpipe (LLVM 17.0.6 256 bits), OpenGL 4.5)',
		'Microsoft Basic Render Driver',
		'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
		'softpipe',
		'lavapipe',
	]
	const hardware = [
		'Apple M2',
		'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
		'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
		'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
		// Mesa also drives real GPUs: only its software rasterizers count.
		'Mesa Intel(R) Xe Graphics (TGL GT2)',
		'AMD Radeon Pro 5500M OpenGL Engine',
		'Adreno (TM) 740',
		'Mali-G78 MC24',
	]
	expect(software.filter((name) => !isSoftwareRenderer(name))).toEqual([])
	expect(hardware.filter((name) => isSoftwareRenderer(name))).toEqual([])
})

test('the lantern needs WebGL2 on a GPU', () => {
	let webgl = stubWebgl({
		renderer:
			'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
	})
	expect(hasLanternGpu()).toBe(true)
	expect(webgl.requests).toEqual([
		{ type: 'webgl2', options: { failIfMajorPerformanceCaveat: true } },
	])
	// The probe gives its context back.
	expect(webgl.lost()).toBe(true)

	// The browser refuses a context on a software or blocklisted GPU.
	stubWebgl(null)
	expect(hasLanternGpu()).toBe(false)

	// A masked renderer is read through the debug extension.
	webgl = stubWebgl({
		renderer: 'WebKit WebGL',
		unmasked: 'Google SwiftShader',
	})
	expect(hasLanternGpu()).toBe(false)
	expect(webgl.lost()).toBe(true)
	stubWebgl({ renderer: 'WebKit WebGL', unmasked: 'Apple GPU' })
	expect(hasLanternGpu()).toBe(true)

	stubWebgl({ renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' })
	expect(hasLanternGpu()).toBe(false)
})

test('the lantern needs half-float targets to glow past white', () => {
	const gpu =
		'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'
	const webgl = stubWebgl({ renderer: gpu, floatColor: [] })
	expect(hasLanternGpu()).toBe(false)
	expect(webgl.lost()).toBe(true)
	stubWebgl({ renderer: gpu, floatColor: ['EXT_color_buffer_half_float'] })
	expect(hasLanternGpu()).toBe(true)
})
