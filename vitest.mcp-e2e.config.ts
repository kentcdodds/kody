import { defineProject, mergeConfig } from 'vitest/config'
import { sharedProjectConfig } from './vitest-shared.ts'

// This suite is intentionally just a couple of smoke journeys. They share one
// Wrangler test harness (see getSharedMcpE2eServer) and each test seeds its
// own user/org. Concurrent local validation still needs more headroom than an
// isolated run because OAuth + MCP handshakes contend with other suites.
const mcpE2eTimeout = process.env.CI ? 120_000 : 90_000

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		test: {
			name: 'mcp-e2e',
			environment: 'node',
			include: ['**/*.mcp-e2e.test.ts'],
			testTimeout: mcpE2eTimeout,
			hookTimeout: mcpE2eTimeout,
			// Shared harness + D1: files must not run in parallel.
			fileParallelism: false,
		},
	}),
)
