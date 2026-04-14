import { defineProject, mergeConfig } from 'vitest/config'
import { sharedProjectConfig } from './vitest-shared.ts'

// Local `wrangler dev` + `d1 migrations apply` cold-start often exceeds 10s; keep
// local timeouts aligned with CI so the suite measures MCP behavior, not harness speed.
const mcpE2eTimeout = 30_000

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
