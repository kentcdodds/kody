import { afterEach, expect, test, vi } from 'vitest'
import { hasLanternGpu, isSoftwareRenderer } from './landing-lantern-3d-gpu.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

type AdapterInfo = {
	vendor: string
	architecture: string
	device: string
	description: string
	isFallbackAdapter?: boolean
}

function stubWebgpu(adapter: { info?: AdapterInfo } | null) {
	vi.stubGlobal('navigator', {
		gpu: { requestAdapter: async () => adapter },
	})
}

function stubWebgl(context: { renderer: string; unmasked?: string } | null) {
	const requests: Array<unknown> = []
	let lost = false
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
			return null
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

test('a WebGPU adapter decides when the browser offers one', async () => {
	const hardware = {
		vendor: 'apple',
		architecture: 'metal-3',
		device: '',
		description: '',
		isFallbackAdapter: false,
	}
	stubWebgpu({ info: hardware })
	const webgl = stubWebgl(null)
	await expect(hasLanternGpu()).resolves.toBe(true)
	// GSS will draw with WebGPU, so WebGL2 is not asked.
	expect(webgl.requests).toHaveLength(0)

	stubWebgpu({ info: { ...hardware, isFallbackAdapter: true } })
	await expect(hasLanternGpu()).resolves.toBe(false)

	stubWebgpu({
		info: {
			vendor: 'google',
			architecture: 'swiftshader',
			device: '',
			description: '',
		},
	})
	await expect(hasLanternGpu()).resolves.toBe(false)

	// Browsers from before adapter info say nothing either way.
	stubWebgpu({})
	await expect(hasLanternGpu()).resolves.toBe(true)
})

test('without WebGPU, WebGL2 must be on a GPU', async () => {
	vi.stubGlobal('navigator', {})
	let webgl = stubWebgl({
		renderer:
			'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
	})
	await expect(hasLanternGpu()).resolves.toBe(true)
	expect(webgl.requests).toEqual([
		{ type: 'webgl2', options: { failIfMajorPerformanceCaveat: true } },
	])
	// The probe gives its context back.
	expect(webgl.lost()).toBe(true)

	// The browser refuses a context on a software or blocklisted GPU.
	stubWebgl(null)
	await expect(hasLanternGpu()).resolves.toBe(false)

	// A masked renderer is read through the debug extension.
	webgl = stubWebgl({
		renderer: 'WebKit WebGL',
		unmasked: 'Google SwiftShader',
	})
	await expect(hasLanternGpu()).resolves.toBe(false)
	expect(webgl.lost()).toBe(true)
	stubWebgl({ renderer: 'WebKit WebGL', unmasked: 'Apple GPU' })
	await expect(hasLanternGpu()).resolves.toBe(true)

	// WebGPU without an adapter (blocklisted) falls back the same way.
	stubWebgpu(null)
	stubWebgl({ renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' })
	await expect(hasLanternGpu()).resolves.toBe(false)
})
