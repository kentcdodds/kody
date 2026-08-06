import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const yogaWasmPath = require.resolve('satori/yoga.wasm')
const resvgWasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm')

export {
	getBricolageGrotesqueLatin700FontData,
	getWixMadeforTextLatin400FontData,
} from './fonts.ts'

export const ogYogaWasm = await WebAssembly.compile(readFileSync(yogaWasmPath))
export const ogResvgWasm = await WebAssembly.compile(
	readFileSync(resvgWasmPath),
)
