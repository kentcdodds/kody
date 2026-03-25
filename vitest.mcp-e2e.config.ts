import { defineProject, mergeConfig } from 'vitest/config'
import { sharedProjectConfig } from './vitest-shared.ts'

const mcpE2eTimeout = process.env.CI ? 30_000 : 10_000

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		test: {
			name: 'mcp-e2e',
			environment: 'node',
			include: ['packages/worker/src/mcp/mcp-server-e2e.test.ts'],
			testTimeout: mcpE2eTimeout,
			hookTimeout: mcpE2eTimeout,
		},
	}),
)
