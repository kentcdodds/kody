import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { remix } from '@pitlane/dev'
import { defineConfig } from 'vite'
import { parseJsonc } from './tools/ci/resource-utils.ts'
import { writeLocalPlatformDevConfig } from './tools/local-platform-dev-config.ts'
import { writeLocalRuntimeDevConfig } from './tools/local-runtime-dev-config.ts'
import { ensureGuideCatalogModules } from './tools/build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './tools/build-worker-bundler-modules.ts'

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

export default defineConfig(async () => {
	await ensureWorkerBundlerModules()
	await ensureGuideCatalogModules()

	const auxiliaryWorkers: Array<{
		configPath: string
		devOnly: true
	}> = [
		{
			configPath: 'packages/jobs-worker/wrangler.jsonc',
			devOnly: true,
		},
		{
			configPath: 'packages/highlight-worker/wrangler.jsonc',
			devOnly: true,
		},
	]

	if (envName !== 'test' && !isOriginDeployBuild) {
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

	return {
		publicDir: 'packages/worker/public',
		plugins: [
			remix({
				serverHandler: false,
				clientEntry: 'packages/worker/client/entry.tsx',
				serverEntry: resolveWorkerEntry(wranglerConfigPath),
				serverEnvironments: ['ssr'],
			}),
			cloudflare({
				configPath: wranglerConfigPath,
				viteEnvironment: { name: 'ssr' },
				persistState: { path: persistPath },
				remoteBindings: false,
				auxiliaryWorkers,
			}),
		],
		resolve: {
			alias: [
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
