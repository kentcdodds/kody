import { afterAll } from 'vitest'
import { stopSharedMcpE2eServer } from './mcp-test-support.ts'

type VitestWorkerState = {
	filepath?: string
	ctx?: {
		files?: Array<string | { filepath?: string }>
	}
}

/**
 * Shared Wrangler harness teardown. Vitest setupFiles re-import per file
 * (even with isolate: false), so afterAll registers for each file. Stop only
 * after the last file in this worker's run — earlier stops would cold-boot
 * the harness again and undo the shared-server win. Vitest awaits afterAll;
 * process `beforeExit` does not run when the pool exits via process.exit()
 * while Miniflare still holds the event loop.
 */
afterAll(async () => {
	const worker = (
		globalThis as typeof globalThis & {
			__vitest_worker__?: VitestWorkerState
		}
	).__vitest_worker__
	const files = worker?.ctx?.files ?? []
	const paths = files.map((file) =>
		typeof file === 'string' ? file : (file.filepath ?? ''),
	)
	const current = worker?.filepath
	if (paths.length > 0 && current && paths.at(-1) !== current) return
	await stopSharedMcpE2eServer()
})
