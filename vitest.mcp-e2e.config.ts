import { defineProject, mergeConfig } from 'vitest/config'
import { sharedProjectConfig } from './vitest-shared.ts'

// Wrangler dev + OAuth + multiple MCP round-trips per test routinely exceed 30s on
// cold CI runners; keep local runs snappy but allow headroom in CI.
const mcpE2eTimeout = process.env.CI ? 120_000 : 10_000

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		test: {
			name: 'mcp-e2e',
			environment: 'node',
			include: ['**/*.mcp-e2e.test.ts'],
			testTimeout: mcpE2eTimeout,
			hookTimeout: mcpE2eTimeout,
		},
	}),
)
