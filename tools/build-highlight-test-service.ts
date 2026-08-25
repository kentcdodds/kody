import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Bundles tools/highlight-test-service.entry.ts into a standalone worker
 * module for the workers-unit vitest pool's auxiliary "kody-highlight-test"
 * worker (see vitest.workers.config.ts). Miniflare auxiliary workers take a
 * prebuilt script.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(repoRoot, '.tmp/highlight-test-service')

export const highlightTestServiceScriptPath = path.join(outDir, 'index.mjs')

export async function buildHighlightTestService() {
	await mkdir(outDir, { recursive: true })
	await build({
		entryPoints: [path.join(repoRoot, 'tools/highlight-test-service.entry.ts')],
		outfile: highlightTestServiceScriptPath,
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		conditions: ['workerd', 'worker', 'import'],
	})
}
