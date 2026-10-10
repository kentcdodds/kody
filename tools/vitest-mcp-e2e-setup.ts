import { stopSharedMcpE2eServer } from './mcp-test-support.ts'

const teardownKey = Symbol.for('kody.mcpE2e.teardownRegistered')

type TeardownGlobal = typeof globalThis & {
	[teardownKey]?: boolean
}

/**
 * Register process teardown once for the shared Wrangler harness. Vitest
 * setupFiles re-import across files when isolate is true; globalThis keeps
 * this idempotent. `beforeExit` awaits async close of the mock persist dir.
 */
const teardownGlobal = globalThis as TeardownGlobal
if (!teardownGlobal[teardownKey]) {
	teardownGlobal[teardownKey] = true
	let closing: Promise<void> | null = null
	process.once('beforeExit', () => {
		closing ??= stopSharedMcpE2eServer()
		void closing
	})
}
