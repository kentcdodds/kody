import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotEnv } from 'dotenv'
import { type UserConfig } from 'vitest/config'

export const rootDir = fileURLToPath(new URL('.', import.meta.url))
const testTimeout = process.env.CI ? 20_000 : 5_000

loadDotEnv({
	path: resolve(rootDir, 'packages/worker/.env'),
	quiet: true,
})

// Several npm packages (e.g. @modelcontextprotocol/sdk, cron-schedule) ship
// sourcemaps whose `sources` files are not published, and Vite warns once per
// transformed file ("Sourcemap ... points to missing source files"). That is
// third-party packaging noise we cannot act on, so only surface Vite errors.
export const viteLogLevel = 'error' as const

export const sharedProjectConfig = {
	logLevel: viteLogLevel,
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
