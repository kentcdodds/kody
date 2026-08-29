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
 *
 * Esbuild's native source-graph watcher still rebuilds on this overlay even
 * when Node `fs.watch` reports no generated-file events. For Playwright /
 * `CLOUDFLARE_ENV=test`, wrangler-env also sets
 * `WRANGLER_DISABLE_BUNDLE_WATCH=true` and this rewrite honors it so the
 * main bundle does not watch after the first compile.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const wranglerCliPath = path.join(
	repoRoot,
	'node_modules/wrangler/wrangler-dist/cli.js',
)

const patchMarker = 'kody-1789'
const watchBlockPattern =
	/if \(props\.findAdditionalModules\) \{\s*watchFiles = foundModulePaths(?:\.filter\(\(p\) => !p\.includes\("\.kody-generated"\)\))?;\s*const root = path31__namespace\.default\.resolve\(props\.entry\.moduleRoot\);\s*for await \(const dir\d+ of findAdditionalModuleWatchDirs\(root\)\) \{\s*watchDirs\.push\(dir\d+\);\s*\}\s*\}/

const patchedBlock = `if (props.findAdditionalModules) {
              // ${patchMarker}: generated additional modules must not be watched
            }`

const unpatchedBundleWatch = 'watch: config6.dev.watch ?? true'
const patchedBundleWatch =
	'watch: config6.dev.watch ?? (process.env.WRANGLER_DISABLE_BUNDLE_WATCH !== "true")'

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

export function wranglerBundleWatchSource(source: string) {
	if (source.includes(patchedBundleWatch)) {
		return { source, patched: true, changed: false }
	}
	if (!source.includes(unpatchedBundleWatch)) {
		throw new Error(
			`wrangler ${wranglerCliPath} no longer defaults BundlerController watch to true; rebase the Friction #1789 bundle-watch gate.`,
		)
	}
	return {
		source: source.replace(unpatchedBundleWatch, patchedBundleWatch),
		patched: true,
		changed: true,
	}
}

export async function ensureWranglerFiltersKodyGeneratedWatch() {
	const source = await readFile(wranglerCliPath, 'utf8')
	const additional = wranglerAdditionalModuleWatchSource(source)
	const bundle = wranglerBundleWatchSource(additional.source)
	const changed = additional.changed || bundle.changed
	if (changed) {
		await writeFile(wranglerCliPath, bundle.source)
	}
	return { source: bundle.source, patched: true, changed }
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await ensureWranglerFiltersKodyGeneratedWatch()
	console.log(
		result.changed
			? 'Patched wrangler additional-module watcher (Friction #1789).'
			: 'Wrangler additional-module watcher already patched (Friction #1789).',
	)
}
