import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			'./vitest.node.config.ts',
			'./vitest.workers.config.ts',
			'./vitest.mcp-e2e.config.ts',
		],
	},
})
