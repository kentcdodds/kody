import type * as workerBundler from '@cloudflare/worker-bundler'
import type * as workerBundlerTypescript from '@cloudflare/worker-bundler/typescript'

/**
 * Lazy access to the runtime worker bundler, loaded from pre-bundled modules
 * in `./node_modules/.kody-generated/` (built by
 * `tools/build-worker-bundler-modules.ts` into `packages/worker/.generated/`
 * and hardlinked here).
 *
 * Importing `@cloudflare/worker-bundler` directly — even via dynamic
 * `import()` — gets inlined into the single main worker module by wrangler,
 * which put ~3.6 MB of bundler/TypeScript compiler into every isolate cold
 * start. The generated `.mjs` files match a `find_additional_modules` rule in
 * `wrangler.jsonc`, so wrangler uploads them as separate external modules
 * that only load and evaluate when repo checks actually run.
 *
 * The `node_modules/` prefix is load-bearing: wrangler's additional-module
 * walker discovers these files under `src/`, but its watcher skips
 * `node_modules`, so overlay-FS create events on `esbuild.wasm` do not
 * retrigger `wrangler dev` (Friction #1789).
 */

export function importWorkerBundler(): Promise<typeof workerBundler> {
	return import('./node_modules/.kody-generated/worker-bundler.mjs')
}

export function importWorkerBundlerTypescript(): Promise<
	typeof workerBundlerTypescript
> {
	return import('./node_modules/.kody-generated/worker-bundler-typescript.mjs')
}
