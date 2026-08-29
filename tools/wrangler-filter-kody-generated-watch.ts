import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Wrangler file-watches every additional module it discovers and directory-
 * watches the entry tree (except `node_modules` / `.git`). On Cloud Agent
 * overlay FS, create events on those paths retrigger attach — including the
 * ~17 MB `esbuild.wasm` — and loop `Reloading local server...`
 * (Friction #1789).
 *
 * Additional modules here are generated artifacts (worker-bundler, guide
 * catalog). This patch leaves `find_additional_modules` upload alone and
 * clears esbuild `watchFiles` / `watchDirs` for that collector so overlay
 * events cannot rebuild the worker.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const wranglerCliPath = path.join(
	repoRoot,
	'node_modules/wrangler/wrangler-dist/cli.js',
)

const patchMarker = 'kody-1789'
const watchBlockPattern =
	/if \(props\.findAdditionalModules\) \{\s*watchFiles = foundModulePaths(?:\.filter\(\(p\) => !p\.includes\("\.kody-generated"\)\))?;\s*const root = path31__namespace\.default\.resolve\(props\.entry\.moduleRoot\);\s*for await \(const dir5 of findAdditionalModuleWatchDirs\(root\)\) \{\s*watchDirs\.push\(dir5\);\s*\}\s*\}/

const patchedBlock = `if (props.findAdditionalModules) {
              // ${patchMarker}: generated additional modules must not be watched
            }`

export function wranglerAdditionalModuleWatchSource(source: string) {
	if (source.includes(patchMarker)) {
		return { source, patched: true, changed: false }
	}
	if (!watchBlockPattern.test(source)) {
		throw new Error(
			`wrangler ${wranglerCliPath} no longer watches additional modules via foundModulePaths; rebase the Friction #1789 watch filter.`,
		)
	}
	return {
		source: source.replace(watchBlockPattern, patchedBlock),
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
			? 'Patched wrangler additional-module watcher (Friction #1789).'
			: 'Wrangler additional-module watcher already patched (Friction #1789).',
	)
}
