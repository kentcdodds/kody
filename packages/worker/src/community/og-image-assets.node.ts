import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const yogaWasmPath = require.resolve('satori/yoga.wasm')
const resvgWasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm')

export { getInterLatin400FontData } from './og-image-font.ts'

export const communityOgYogaWasm = await WebAssembly.compile(
	readFileSync(yogaWasmPath),
)
export const communityOgResvgWasm = await WebAssembly.compile(
	readFileSync(resvgWasmPath),
)
