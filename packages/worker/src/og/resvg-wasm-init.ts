import { initWasm } from '@resvg/resvg-wasm'
import { ogResvgWasm } from '#worker/og/og-image-assets.ts'

/**
 * resvg wasm init, separate from `render.ts` on purpose: community icon
 * rendering only rasterizes SVG (no satori markup), and importing
 * `render.ts` for its init helper dragged satori + opentype into the static
 * module graph of every isolate. Keeping the resvg-only init here lets
 * `render.ts` (and satori with it) stay behind the dynamic OG imports.
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
