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
				miniflare: {
					// The test env's JOBS service binding (ADR 0016) targets the
					// jobs worker, which local `wrangler dev` runs alongside the
					// main worker; the pool only loads the main config, so an
					// auxiliary worker (bundled by the global setup below) serves
					// the JobsService contract from its own D1 database.
					workers: [
						{
							name: 'kody-jobs-test',
							modules: true,
							scriptPath: resolve(rootDir, '.tmp/jobs-test-service/index.mjs'),
							compatibilityDate: '2025-06-01',
							d1Databases: ['JOBS_DB'],
						},
					],
				},
			}),
		],
		test: {
			name: 'workers-unit',
			include: ['**/*.workers.test.ts'],
			globalSetup: [
				resolve(rootDir, 'tools/vitest-global-setup-worker-bundler-modules.ts'),
				resolve(rootDir, 'tools/vitest-global-setup-jobs-test-service.ts'),
			],
		},
	}),
)
