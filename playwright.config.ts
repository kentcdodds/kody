import { defineConfig, devices } from '@playwright/test'

const hasExplicitBaseUrl = Boolean(process.env.PLAYWRIGHT_BASE_URL)
const resolvedPlaywrightPort = process.env.PLAYWRIGHT_PORT ?? '3847'
const baseURL =
	process.env.PLAYWRIGHT_BASE_URL ??
	`http://127.0.0.1:${resolvedPlaywrightPort}`
const playwrightPersistPath =
	process.env.PLAYWRIGHT_PERSIST_PATH ?? '.wrangler/state/e2e'
const webServerCommand =
	`npm run build:client && ` +
	`node --env-file=packages/worker/.env ./wrangler-env.ts d1 migrations apply APP_DB --local --persist-to "${playwrightPersistPath}" && ` +
	`node --env-file=packages/worker/.env ./wrangler-env.ts dev --local --persist-to "${playwrightPersistPath}"`

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL,
		trace: 'on-first-retry',
	},
	webServer: {
		command: webServerCommand,
		url: baseURL,
		reuseExistingServer: hasExplicitBaseUrl,
		env: {
			CLOUDFLARE_ENV: 'test',
			PORT: resolvedPlaywrightPort,
			WRANGLER_LOG_PATH: './logs.local',
			WRANGLER_DISABLE_REQUEST_BODY_DRAINING: 'true',
		},
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
})
