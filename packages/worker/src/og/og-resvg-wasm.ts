/**
 * Resvg WASM only — kept separate from `og-image-assets.ts` so community-icon
 * rasterization (static on every isolate) does not also link Satori's yoga
 * WASM or the OG binary-asset module graph.
 */
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'

export const ogResvgWasm = resvgWasm
