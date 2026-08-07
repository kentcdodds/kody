import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const yogaWasmPath = require.resolve('satori/yoga.wasm')
const resvgWasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm')

export {
	ensureOgBinaryAssetsReady,
	getBricolageGrotesqueLatin700FontData,
	getKodyHeroDataUri,
	getKodyLogoDataUri,
	getKodyPatternDataUri,
	getWixMadeforTextLatin400FontData,
	resetOgBinaryAssetsCache,
	type OgAssetsFetcher,
} from './og-binary-assets.node.ts'

export const ogYogaWasm = await WebAssembly.compile(readFileSync(yogaWasmPath))
export const ogResvgWasm = await WebAssembly.compile(
	readFileSync(resvgWasmPath),
)
