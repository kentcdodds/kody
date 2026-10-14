import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { remix } from '@pitlane/dev'
import { defineConfig } from 'vite'
import { parseJsonc } from './tools/ci/resource-utils.ts'
import {
	collectLocalOriginDevVars,
	localGeneratedConfigBasename,
	writeLocalOriginDevConfig,
} from './tools/local-origin-dev-config.ts'
import { writeLocalAuxiliaryDevConfig } from './tools/local-auxiliary-dev-config.ts'
import { writeLocalPlatformDevConfig } from './tools/local-platform-dev-config.ts'
import { writeLocalRuntimeDevConfig } from './tools/local-runtime-dev-config.ts'
import { resolveLocalD1PersistPath } from './tools/local-d1-persist.ts'
import { ensureGuideCatalogModules } from './tools/build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './tools/build-worker-bundler-modules.ts'
import { markdownAsText } from './tools/vite-markdown-as-text.ts'
import { workerWholeGraphReload } from './tools/vite-worker-whole-graph-reload.ts'

const root = path.dirname(fileURLToPath(import.meta.url))
// `@cloudflare/vite-plugin` reads `CLOUDFLARE_ENV` itself (not this
// file's `envName`) to pick `env.production` / `env.test` bindings. Local
// `npm run dev` does not set the variable, so without this default the
// plugin loads the top-level wrangler config (no D1/DO/KV) and origin
// `/health` fails with Missing APP_DB.
const envName = process.env.CLOUDFLARE_ENV?.trim() || 'production'
if (!process.env.CLOUDFLARE_ENV?.trim()) {
	process.env.CLOUDFLARE_ENV = envName
}
const persistPath = resolveLocalD1PersistPath()
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
		// E2E uses a separate generated basename so it cannot overwrite a
		// concurrent `dev:ensure` config on reload (#3731).
		const generatedBasename = localGeneratedConfigBasename(process.env)
		serveWranglerConfigPath = await writeLocalOriginDevConfig({
			originConfigPath: wranglerConfigPath,
			envName,
			vars: collectLocalOriginDevVars(process.env, process.env.PORT),
			generatedBasename,
		})
		// Jobs + highlight stay attached in the test env (Playwright e2e).
		// Platform/runtime have no test env and stay skipped there. Pin the
		// registered names so origin `service: "kody-jobs"` / `kody-highlight`
		// resolve under `--env production` (otherwise wrangler registers
		// `kody-jobs-production`).
		const jobsDevConfigPath = await writeLocalAuxiliaryDevConfig({
			configPath: 'packages/jobs-worker/wrangler.jsonc',
			envName,
			mainWorkerDevName: `kody-${envName}`,
			generatedBasename,
		})
		const highlightDevConfigPath = await writeLocalAuxiliaryDevConfig({
			configPath: 'packages/highlight-worker/wrangler.jsonc',
			envName,
			mainWorkerDevName: `kody-${envName}`,
			generatedBasename,
		})
		auxiliaryWorkers.push(
			{
				configPath: jobsDevConfigPath,
				devOnly: true,
			},
			{
				configPath: highlightDevConfigPath,
				devOnly: true,
			},
		)
		if (envName !== 'test') {
			const runtimeDevConfigPath = await writeLocalRuntimeDevConfig({
				runtimeConfigPath: 'packages/runtime-worker/wrangler.jsonc',
				envName,
				mainWorkerDevName: `kody-${envName}`,
				port: process.env.PORT,
				generatedBasename,
			})
			const platformDevConfigPath = await writeLocalPlatformDevConfig({
				platformConfigPath: 'packages/platform-worker/wrangler.jsonc',
				envName,
				mainWorkerDevName: `kody-${envName}`,
				port: process.env.PORT,
				generatedBasename,
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
				// E2E webServer sets KODY_E2E_WEB_SERVER=1 and uses its own
				// persist dir + port. Disabling the inspector avoids fighting
				// a healthy `dev:ensure` origin for the default inspector port
				// (Parent environment not initialized / #3731).
				inspectorPort: (() => {
					if (process.env.KODY_E2E_WEB_SERVER === '1') return false
					if (process.env.KODY_VITE_INSPECTOR_PORT === 'false') return false
					const raw = process.env.KODY_VITE_INSPECTOR_PORT?.trim()
					if (!raw) return undefined
					if (!/^\d+$/.test(raw)) return undefined
					const port = Number.parseInt(raw, 10)
					return Number.isFinite(port) ? port : undefined
				})(),
				remoteBindings: false,
				auxiliaryWorkers,
			}),
			workerWholeGraphReload(),
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
				importSource: 'remix/component',
			},
		},
	}
})
