import { defineConfig } from 'vitest/config'
import { viteLogLevel } from './vitest-shared.ts'

export default defineConfig({
	// The workers pool resolves modules through this root-level Vite server, so
	// the broken-third-party-sourcemap warning filter has to apply here too
	// (see vitest-shared.ts).
	logLevel: viteLogLevel,
	test: {
		projects: [
			'./vitest.node.config.ts',
			'./vitest.workers.config.ts',
			'./vitest.mcp-e2e.config.ts',
		],
	},
})
