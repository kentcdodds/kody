import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotEnv } from 'dotenv'
import { type UserConfig } from 'vitest/config'
import { suppressThirdPartySourcemapWarnings } from './tools/vite-suppress-sourcemap-warnings.ts'

export const rootDir = fileURLToPath(new URL('.', import.meta.url))
const testTimeout = process.env.CI ? 20_000 : 5_000

loadDotEnv({
	path: resolve(rootDir, 'packages/worker/.env'),
	quiet: true,
})

export const sharedProjectConfig = {
	plugins: [suppressThirdPartySourcemapWarnings()],
	resolve: {
		alias: [
			{
				find: /^#app\//,
				replacement: `${resolve(rootDir, 'packages/worker/src/app')}/`,
			},
			{
				find: /^#client\//,
				replacement: `${resolve(rootDir, 'packages/worker/client')}/`,
			},
			{
				find: /^#worker\//,
				replacement: `${resolve(rootDir, 'packages/worker/src')}/`,
			},
			{
				find: /^#mcp\//,
				replacement: `${resolve(rootDir, 'packages/worker/src/mcp')}/`,
			},
		],
	},
	oxc: {
		target: 'es2023',
		jsx: {
			runtime: 'automatic',
			importSource: 'remix/ui',
		},
	},
	test: {
		testTimeout,
		hookTimeout: testTimeout,
		fileParallelism: false,
		clearMocks: true,
		mockReset: true,
		setupFiles: [
			resolve(rootDir, 'packages/worker/src/test-support/console-spies.ts'),
		],
		// msw's cookie store probes `typeof localStorage`, which trips Node's
		// experimental localStorage warning in every fork that loads it.
		execArgv: ['--disable-warning=ExperimentalWarning'],
	},
} satisfies UserConfig
