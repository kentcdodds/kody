import { initWasm } from '@resvg/resvg-wasm'
import { ogResvgWasm } from '#worker/og/og-resvg-wasm.ts'

/**
 * resvg wasm init, separate from `render.ts` on purpose: community icon
 * rendering only rasterizes SVG (no satori markup), and importing
 * `render.ts` for its init helper dragged satori + opentype into the static
 * module graph of every isolate. This module imports only `og-resvg-wasm`
 * (not `og-image-assets`) so yoga WASM and OG binary assets stay behind the
 * dynamic OG imports.
 */
let resvgReady: Promise<void> | null = null

export function ensureResvgWasmReady(): Promise<void> {
	if (!resvgReady) {
		resvgReady = initWasm(ogResvgWasm)
			.then(() => undefined)
			.catch((error) => {
				resvgReady = null
				throw error
			})
	}
	return resvgReady
}
