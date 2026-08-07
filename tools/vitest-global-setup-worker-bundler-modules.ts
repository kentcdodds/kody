import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'

/**
 * Vitest global setup: repo-check and package-runtime tests dynamically
 * import the pre-bundled worker-bundler modules from
 * `packages/worker/src/generated/`, which are gitignored build artifacts.
 * Generating them here keeps `vitest run` working on a fresh clone. The
 * generator is stamped, so warm runs cost ~0 ms.
 */
export default async function setup() {
	await ensureWorkerBundlerModules()
}
