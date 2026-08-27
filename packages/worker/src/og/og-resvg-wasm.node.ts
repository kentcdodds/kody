import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const resvgWasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm')

export const ogResvgWasm = await WebAssembly.compile(
	readFileSync(resvgWasmPath),
)
