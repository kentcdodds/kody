import { resolve } from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		plugins: [
			cloudflareTest({
				remoteBindings: false,
				wrangler: {
					configPath: resolve(rootDir, 'packages/worker/wrangler.jsonc'),
					environment: 'test',
				},
			}),
		],
		test: {
			name: 'workers-unit',
			include: ['**/*.workers.test.ts'],
		},
	}),
)
