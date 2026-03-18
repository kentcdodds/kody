import { defineConfig, devices } from '@playwright/test'

const playwrightPort = process.env.PLAYWRIGHT_PORT ?? '8788'
const baseURL =
	process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${playwrightPort}`

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
		command: 'bun run build:client && bun run preview:e2e',
		url: baseURL,
		reuseExistingServer: true,
		env: {
			CLOUDFLARE_ENV: 'test',
			PORT: playwrightPort,
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
