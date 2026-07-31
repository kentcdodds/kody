import { resolve } from 'node:path'
import {
	cloudflareTest,
	readD1Migrations,
} from '@cloudflare/vitest-pool-workers'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

// The pool restarts a Wrangler config read per test file, and each read logs
// "Using secrets defined in packages/worker/.env" at the default log level.
process.env.WRANGLER_LOG ??= 'warn'

const auditMigrations = await readD1Migrations(
	resolve(rootDir, 'packages/worker/audit-migrations'),
)

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		plugins: [
			cloudflareTest({
				remoteBindings: false,
				miniflare: {
					bindings: { TEST_AUDIT_MIGRATIONS: auditMigrations },
				},
				wrangler: {
					configPath: resolve(rootDir, 'packages/worker/wrangler.jsonc'),
					environment: 'test',
				},
			}),
		],
		test: {
			name: 'workers-unit',
			include: ['**/*.workers.test.ts'],
			setupFiles: [
				resolve(
					rootDir,
					'packages/worker/src/test-support/audit-db-schema.ts',
				),
			],
		},
	}),
)
