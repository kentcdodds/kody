import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { remix } from '@pitlane/dev'
import { defineConfig } from 'vite'
import { parseJsonc } from './tools/ci/resource-utils.ts'
import {
	collectLocalOriginDevVars,
	writeLocalOriginDevConfig,
} from './tools/local-origin-dev-config.ts'
import { writeLocalPlatformDevConfig } from './tools/local-platform-dev-config.ts'
import { writeLocalRuntimeDevConfig } from './tools/local-runtime-dev-config.ts'
import { ensureGuideCatalogModules } from './tools/build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './tools/build-worker-bundler-modules.ts'
import { markdownAsText } from './tools/vite-markdown-as-text.ts'

const root = path.dirname(fileURLToPath(import.meta.url))
const envName = process.env.CLOUDFLARE_ENV ?? 'production'
const persistPath = process.env.WRANGLER_PERSIST_TO ?? '.wrangler/state'
const wranglerConfigPath =
	process.env.KODY_WRANGLER_CONFIG ?? 'packages/worker/wrangler.jsonc'
const isOriginDeployBuild = Boolean(process.env.KODY_WRANGLER_CONFIG)

function resolveWorkerEntry(configPath: string) {
	const absoluteConfig = path.resolve(root, configPath)
	const config = parseJsonc<{ main?: string }>(
		readFileSync(absoluteConfig, 'utf8'),
	)
	const main = config.main ?? './src/index.ts'
	return path.relative(root, path.resolve(path.dirname(absoluteConfig), main))
}

function alias(prefix: string, target: string) {
	return {
		find: new RegExp(`^${prefix}/`),
		replacement: `${target}/`,
	}
}

export default defineConfig(async ({ command }) => {
	await ensureWorkerBundlerModules()
	await ensureGuideCatalogModules()

	const auxiliaryWorkers: Array<{
		configPath: string
		devOnly: true
	}> = []
	let serveWranglerConfigPath = wranglerConfigPath

	if (command === 'serve' && !isOriginDeployBuild) {
		// Vite's Cloudflare plugin reads Worker bindings from the Wrangler
		// config, not process env. Write the same local-dev vars wrangler-env
		// used to pass with `--var` so origin `env` still sees them.
		serveWranglerConfigPath = await writeLocalOriginDevConfig({
			originConfigPath: wranglerConfigPath,
			envName,
			vars: collectLocalOriginDevVars(process.env, process.env.PORT),
		})
		// Jobs + highlight stay attached in the test env (Playwright e2e).
		// Platform/runtime have no test env and stay skipped there.
		auxiliaryWorkers.push(
			{
				configPath: 'packages/jobs-worker/wrangler.jsonc',
				devOnly: true,
			},
			{
				configPath: 'packages/highlight-worker/wrangler.jsonc',
				devOnly: true,
			},
		)
		if (envName !== 'test') {
			const runtimeDevConfigPath = await writeLocalRuntimeDevConfig({
				runtimeConfigPath: 'packages/runtime-worker/wrangler.jsonc',
				envName,
				mainWorkerDevName: `kody-${envName}`,
				port: process.env.PORT,
			})
			const platformDevConfigPath = await writeLocalPlatformDevConfig({
				platformConfigPath: 'packages/platform-worker/wrangler.jsonc',
				envName,
				mainWorkerDevName: `kody-${envName}`,
				port: process.env.PORT,
			})
			auxiliaryWorkers.push(
				{ configPath: runtimeDevConfigPath, devOnly: true },
				{ configPath: platformDevConfigPath, devOnly: true },
			)
		}
	}

	return {
		publicDir: 'packages/worker/public',
		build: {
			sourcemap: true,
			outDir: process.env.KODY_VITE_OUTDIR ?? 'dist',
		},
		plugins: [
			markdownAsText(),
			remix({
				serverHandler: false,
				clientEntry: 'packages/worker/client/entry.tsx',
				serverEntry: resolveWorkerEntry(serveWranglerConfigPath),
				serverEnvironments: ['ssr'],
			}),
			cloudflare({
				configPath: serveWranglerConfigPath,
				viteEnvironment: { name: 'ssr' },
				persistState: { path: persistPath },
				remoteBindings: false,
				auxiliaryWorkers,
			}),
		],
		resolve: {
			alias: [
				{
					find: /#app\/hmr\.ts$/,
					replacement: path.resolve(
						root,
						'packages/worker/src/app/hmr.vite.ts',
					),
				},
				{
					find: /#app\/client-entry-assets\.ts$/,
					replacement: path.resolve(
						root,
						'packages/worker/src/app/client-entry-assets.vite.ts',
					),
				},
				alias('#app', path.resolve(root, 'packages/worker/src/app')),
				alias('#client', path.resolve(root, 'packages/worker/client')),
				alias('#universal', path.resolve(root, 'packages/worker/universal')),
				alias('#worker', path.resolve(root, 'packages/worker/src')),
				alias('#mcp', path.resolve(root, 'packages/worker/src/mcp')),
			],
		},
		oxc: {
			jsx: {
				runtime: 'automatic',
				importSource: 'remix/ui',
			},
		},
	}
})
