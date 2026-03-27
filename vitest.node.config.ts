import { resolve } from 'node:path'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		ssr: {
			noExternal: ['@cloudflare/codemode'],
		},
		resolve: {
			alias: [
				{
					find: '@sentry/cloudflare',
					replacement: resolve(
						rootDir,
						'packages/worker/src/test-support/sentry-cloudflare-stub.ts',
					),
				},
				{
					find: 'cloudflare:workers',
					replacement: resolve(
						rootDir,
						'packages/worker/src/test-support/cloudflare-workers-stub.ts',
					),
				},
			],
		},
		test: {
			name: 'node-unit',
			environment: 'node',
			include: ['**/*.node.test.ts'],
		},
	}),
)
