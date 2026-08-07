import { resolve } from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

// The pool restarts a Wrangler config read per test file, and each read logs
// "Using secrets defined in packages/worker/.env" at the default log level.
process.env.WRANGLER_LOG ??= 'warn'

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
			globalSetup: [
				resolve(rootDir, 'tools/vitest-global-setup-worker-bundler-modules.ts'),
			],
		},
	}),
)
