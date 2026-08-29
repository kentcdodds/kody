import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Wrangler file-watches every additional module it discovers. On Cloud Agent
 * overlay FS, create events on the worker-bundler artifacts (especially
 * `esbuild.wasm`) retrigger that watcher after attach and loop
 * `Reloading local server...` (Friction #1789).
 *
 * The artifacts live under `src/node_modules/.kody-generated/` so the
 * directory watcher already skips them (`node_modules`). This patch drops
 * those paths from esbuild `watchFiles` so the file watcher skips them too.
 * Upload is unchanged: `find_additional_modules` still attaches the files.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const wranglerCliPath = path.join(
	repoRoot,
	'node_modules/wrangler/wrangler-dist/cli.js',
)

const unpatchedAssignment = 'watchFiles = foundModulePaths;'
const patchedAssignment =
	'watchFiles = foundModulePaths.filter((p) => !p.includes(".kody-generated"));'

export function wranglerAdditionalModuleWatchSource(source: string) {
	if (source.includes(patchedAssignment)) {
		return { source, patched: true, changed: false }
	}
	if (!source.includes(unpatchedAssignment)) {
		throw new Error(
			`wrangler ${wranglerCliPath} no longer assigns watchFiles = foundModulePaths; rebase the Friction #1789 watch filter.`,
		)
	}
	return {
		source: source.replace(unpatchedAssignment, patchedAssignment),
		patched: true,
		changed: true,
	}
}

export async function ensureWranglerFiltersKodyGeneratedWatch() {
	const source = await readFile(wranglerCliPath, 'utf8')
	const result = wranglerAdditionalModuleWatchSource(source)
	if (result.changed) {
		await writeFile(wranglerCliPath, result.source)
	}
	return result
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await ensureWranglerFiltersKodyGeneratedWatch()
	console.log(
		result.changed
			? 'Patched wrangler additional-module watchFiles to skip .kody-generated.'
			: 'Wrangler additional-module watchFiles already skips .kody-generated.',
	)
}
