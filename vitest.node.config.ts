import { resolve } from 'node:path'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
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
			include: [
				'packages/home-connector/src/**/*.test.ts',
				'packages/worker/src/app/**/*.test.ts',
				'packages/worker/src/mcp/github/**/*.test.ts',
				'packages/worker/src/mcp/cursor/**/*.test.ts',
				'packages/worker/src/mcp/cloudflare/**/*.test.ts',
				'packages/worker/src/mcp/context.test.ts',
				'packages/worker/src/mcp/tools/search.test.ts',
				'packages/worker/src/mcp/skills/**/*.test.ts',
				'packages/worker/src/mcp/capabilities/coding/coding-capabilities.test.ts',
			],
		},
	}),
)
