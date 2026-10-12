import { afterAll } from 'vitest'
import { stopSharedMcpE2eServer } from './mcp-test-support.ts'

const teardownKey = Symbol.for('kody.mcpE2e.teardownRegistered')

type TeardownGlobal = typeof globalThis & {
	[teardownKey]?: boolean
	__vitest_worker__?: {
		onCleanup?: (listener: () => unknown) => void
	}
}

/**
 * Shared Wrangler harness teardown. Prefer Vitest worker `onCleanup` (awaited
 * once when the worker finishes all files). Process `beforeExit` does not run
 * when the pool exits via process.exit() while Miniflare still holds the
 * event loop. If `onCleanup` is unavailable, fall back to per-file `afterAll`
 * so dispose still runs (the harness may cold-boot between files).
 */
const teardownGlobal = globalThis as TeardownGlobal
if (!teardownGlobal[teardownKey]) {
	teardownGlobal[teardownKey] = true
	const onCleanup = teardownGlobal.__vitest_worker__?.onCleanup
	if (typeof onCleanup === 'function') {
		onCleanup(async () => {
			await stopSharedMcpE2eServer()
		})
	} else {
		afterAll(async () => {
			await stopSharedMcpE2eServer()
		})
	}
}
