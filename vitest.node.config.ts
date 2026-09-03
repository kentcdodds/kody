import { resolve } from 'node:path'
import { defineProject, mergeConfig } from 'vitest/config'
import { rootDir, sharedProjectConfig } from './vitest-shared.ts'

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		ssr: {
			// Inline so the `cloudflare:workers` alias below applies inside these
			// packages; the OAuth provider (aliased below from its generated
			// deferred module) imports `WorkerEntrypoint` at module top.
			noExternal: [
				'@cloudflare/codemode',
				'@cloudflare/workers-oauth-provider',
			],
		},
		resolve: {
			alias: [
				{
					find: '#worker/og/og-image-assets.ts',
					replacement: resolve(
						rootDir,
						'packages/worker/src/og/og-image-assets.node.ts',
					),
				},
				{
					find: /\/og\/og-image-assets\.ts$/,
					replacement: resolve(
						rootDir,
						'packages/worker/src/og/og-image-assets.node.ts',
					),
				},
				{
					find: '#worker/og/og-resvg-wasm.ts',
					replacement: resolve(
						rootDir,
						'packages/worker/src/og/og-resvg-wasm.node.ts',
					),
				},
				{
					find: /\/og\/og-resvg-wasm\.ts$/,
					replacement: resolve(
						rootDir,
						'packages/worker/src/og/og-resvg-wasm.node.ts',
					),
				},
				{
					find: '#worker/og/og-binary-assets.ts',
					replacement: resolve(
						rootDir,
						'packages/worker/src/og/og-binary-assets.node.ts',
					),
				},
				{
					find: /\/og\/og-binary-assets\.ts$/,
					replacement: resolve(
						rootDir,
						'packages/worker/src/og/og-binary-assets.node.ts',
					),
				},
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
				// The generated deferred module lives under a `node_modules/`
				// path, which vite-node would externalize (so the
				// `cloudflare:workers` alias above would not reach it). Point node
				// tests at the installed package instead; `ssr.noExternal` inlines
				// it so the alias applies.
				{
					find: './node_modules/.kody-generated/oauth-provider.mjs',
					replacement: '@cloudflare/workers-oauth-provider',
				},
			],
		},
		test: {
			name: 'node-unit',
			environment: 'node',
			include: ['**/*.node.test.ts'],
			globalSetup: [
				resolve(rootDir, 'tools/vitest-global-setup-worker-bundler-modules.ts'),
				resolve(rootDir, 'tools/vitest-global-setup-guide-catalog-modules.ts'),
			],
			// Merged with the shared setupFiles (console spies). Routes the
			// audit-log sink through a shared spy; see test-support/audit-log-spy.ts.
			setupFiles: [
				resolve(rootDir, 'packages/worker/src/test-support/audit-log-spy.ts'),
				resolve(
					rootDir,
					'packages/worker/src/test-support/cloudflare-global-stub.ts',
				),
			],
		},
	}),
)
