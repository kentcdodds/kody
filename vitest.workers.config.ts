import { resolve } from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

// The pool restarts a Wrangler config read per test file, and each read logs
// "Using secrets defined in packages/worker/.env" at the default log level.
process.env.WRANGLER_LOG ??= 'warn'

// Full `npm run validate` runs workers-unit beside Playwright, MCP e2e, and
// many builds on the same machine. Under that load, cold DO RPCs can stretch
// past the shared 20s budget (#2939). `KODY_VALIDATE_LOAD=1` (set on
// validate's test-workers leg only) raises the workers-unit budget and lowers
// maxWorkers. Kept here — not in sharedProjectConfig — so node-unit /
// mcp-e2e never inherit the flag and Nx test/test-node caches stay keyed to
// the 20s default. Does not change production startup CPU budgets.
const underValidateLoad =
	process.env.KODY_VALIDATE_LOAD === '1' ||
	process.env.KODY_VALIDATE_LOAD === 'true'
const workersTestTimeout = underValidateLoad ? 40_000 : 20_000
const workersMaxWorkers = process.env.CI
	? underValidateLoad
		? 2
		: 3
	: undefined

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
					// The test env's JOBS and HIGHLIGHT service bindings target
					// sibling workers that local `wrangler dev` runs alongside
					// the main worker. The pool only loads the main config, so
					// auxiliary workers (bundled by the global setups below)
					// serve those contracts.
					workers: [
						{
							name: 'kody-jobs-test',
							modules: true,
							scriptPath: resolve(rootDir, '.tmp/jobs-test-service/index.mjs'),
							compatibilityDate: '2025-06-01',
							d1Databases: ['JOBS_DB'],
						},
						{
							name: 'kody-highlight-test',
							modules: true,
							scriptPath: resolve(
								rootDir,
								'.tmp/highlight-test-service/index.mjs',
							),
							compatibilityDate: '2025-06-01',
						},
					],
				},
			}),
		],
		test: {
			name: 'workers-unit',
			include: ['**/*.workers.test.ts'],
			testTimeout: workersTestTimeout,
			hookTimeout: workersTestTimeout,
			maxWorkers: workersMaxWorkers,
			globalSetup: [
				resolve(rootDir, 'tools/vitest-global-setup-worker-bundler-modules.ts'),
				resolve(rootDir, 'tools/vitest-global-setup-guide-catalog-modules.ts'),
				resolve(rootDir, 'tools/vitest-global-setup-jobs-test-service.ts'),
				resolve(rootDir, 'tools/vitest-global-setup-highlight-test-service.ts'),
			],
		},
	}),
)
