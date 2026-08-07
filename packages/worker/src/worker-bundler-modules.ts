/**
 * Lazy access to the runtime worker bundler, loaded from pre-bundled modules
 * in `./generated/` (built by `tools/build-worker-bundler-modules.ts`).
 *
 * Importing `@cloudflare/worker-bundler` directly — even via dynamic
 * `import()` — gets inlined into the single main worker module by wrangler,
 * which put ~3.6 MB of bundler/TypeScript compiler into every isolate cold
 * start. The generated `.mjs` files match a `find_additional_modules` rule in
 * `wrangler.jsonc`, so wrangler uploads them as separate external modules
 * that only load and evaluate when repo checks actually run.
 */

export function importWorkerBundler() {
	return import('./generated/worker-bundler.mjs')
}

export function importWorkerBundlerTypescript() {
	return import('./generated/worker-bundler-typescript.mjs')
}
