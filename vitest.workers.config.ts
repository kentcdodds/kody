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
			// First DO class load in the pool is ~10–18s; pay it in setupFiles
			// (see workers-do-warmup.ts) so test bodies stay fast. hookTimeout
			// must cover that first setup per Worker.
			hookTimeout: 60_000,
			setupFiles: [
				resolve(rootDir, 'packages/worker/src/test-support/workers-do-warmup.ts'),
			],
		},
	}),
)
