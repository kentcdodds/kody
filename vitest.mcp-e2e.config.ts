import { defineProject, mergeConfig } from 'vitest/config'
import { sharedProjectConfig } from './vitest-shared.ts'

// This suite is intentionally just a couple of smoke journeys, but each one
// still boots Wrangler and runs a real OAuth + MCP handshake. Give local cloud
// runs enough headroom instead of failing at the old 10s ceiling.
const mcpE2eTimeout = process.env.CI ? 120_000 : 45_000

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
