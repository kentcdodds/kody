import { resolve } from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		plugins: [
			cloudflareTest({
				wrangler: {
					configPath: resolve(rootDir, 'packages/worker/wrangler.jsonc'),
					environment: 'test',
				},
			}),
		],
		test: {
			name: 'workers-unit',
			include: [
				'packages/worker/src/mcp-auth.test.ts',
				'packages/worker/src/oauth-handlers.test.ts',
				'packages/worker/src/mcp/observability.test.ts',
				'packages/worker/src/mcp/capabilities/build-capability-registry.test.ts',
				'packages/worker/src/mcp/capabilities/capability-search.test.ts',
				'packages/worker/src/mcp/capabilities/unified-search.test.ts',
			],
		},
	}),
)
