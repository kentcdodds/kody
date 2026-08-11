import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Bundles tools/jobs-test-service.entry.ts into a standalone worker module
 * for the workers-unit vitest pool's auxiliary "kody-jobs-test" worker (see
 * vitest.workers.config.ts). Miniflare auxiliary workers take a prebuilt
 * script, so the entry (which imports repo TS and the jobs-worker migration
 * SQL) is bundled here once per vitest run.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(repoRoot, '.tmp/jobs-test-service')

export const jobsTestServiceScriptPath = path.join(outDir, 'index.mjs')

export async function buildJobsTestService() {
	await mkdir(outDir, { recursive: true })
	await build({
		entryPoints: [path.join(repoRoot, 'tools/jobs-test-service.entry.ts')],
		outfile: jobsTestServiceScriptPath,
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		conditions: ['workerd', 'worker', 'import'],
		external: ['cloudflare:workers'],
		loader: { '.sql': 'text' },
	})
}
