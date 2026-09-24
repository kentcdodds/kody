import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parseJsonc } from './ci/resource-utils.ts'
import {
	expectedCompiledWasmGlobs,
	expectedEsModuleGlobs,
	strayKodyGeneratedModuleName,
	wranglerAdditionalModuleConfigPaths,
} from './worker-additional-module-allowlist.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

type ModuleRule = {
	type?: string
	globs?: Array<string>
}

test.each(wranglerAdditionalModuleConfigPaths)(
	'%s allowlists generated modules and does not match a stray .mjs',
	async (configPath) => {
		const config = parseJsonc<{ rules?: Array<ModuleRule> }>(
			await readFile(path.join(repoRoot, configPath), 'utf8'),
		)
		const esModule = config.rules?.find((rule) => rule.type === 'ESModule')
		const compiledWasm = config.rules?.find(
			(rule) => rule.type === 'CompiledWasm',
		)
		const esGlobs = esModule?.globs ?? []
		const wasmGlobs = compiledWasm?.globs ?? []
		expect(esGlobs).toEqual(expectedEsModuleGlobs())
		expect(wasmGlobs).toEqual(expectedCompiledWasmGlobs())
		const straySuffix = `/${strayKodyGeneratedModuleName}`
		expect(
			[...esGlobs, ...wasmGlobs].some(
				(glob) => glob.includes('*') || glob.endsWith(straySuffix),
			),
		).toBe(false)
	},
)
