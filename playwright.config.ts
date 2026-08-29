import { defineConfig, devices } from '@playwright/test'

const hasExplicitBaseUrl = Boolean(process.env.PLAYWRIGHT_BASE_URL)
const defaultPlaywrightPort = '3847'
const baseURL =
	process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${defaultPlaywrightPort}`
const webServerCommand = `npm run e2e:web-server -- --port ${defaultPlaywrightPort}`

export default defineConfig({
	testDir: './e2e',
	// Vitest node-unit helpers live beside Playwright specs as
	// `*.node.test.ts`; do not treat them as Playwright tests.
	testIgnore: ['**/*.node.test.ts'],
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// CI runs `validate`, which executes unit, MCP, and Playwright suites
	// concurrently on one runner. The default 30s per-test budget flakes under
	// that resource contention (page.goto alone has been observed taking >30s).
	timeout: process.env.CI ? 60_000 : 30_000,
	// Every worker hits the same local D1 file (`.wrangler/state/e2e`) through
	// Wrangler and the `d1 execute` helpers. Parallel workers cause SQLITE_BUSY
	// and transient 500s during auth/admin flows.
	workers: 1,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL,
		trace: 'on-first-retry',
	},
	webServer: {
		command: webServerCommand,
		url: `${baseURL}/health`,
		// Nx `test-e2e` already built the client. The web server only migrates
		// and starts Wrangler so a second `build-client` does not write
		// `public/` into wrangler's assets watcher. Startup still competes
		// with parallel unit workers during `validate`, and the default 60s
		// budget times out on 4-core CI runners.
		timeout: process.env.CI ? 180_000 : 60_000,
		reuseExistingServer: hasExplicitBaseUrl,
		env: {
			CLOUDFLARE_ENV: 'test',
			// Fatal wrangler exits land here; CI uploads this directory on E2E
			// failure (see validate.yml + e2e/web-server-liveness.ts).
			WRANGLER_LOG_PATH: './logs.local',
			// Keep wrangler's default incoming-body drain. Setting
			// WRANGLER_DISABLE_REQUEST_BODY_DRAINING=true recreates the
			// workers-sdk#5106 ProxyWorker "Network connection lost" race on
			// POST /auth and other JSON posts. wrangler-env.ts also rewrites
			// handleErrorEvent so that race cannot exit wrangler 4.114+
			// (workers-sdk#14926; pending #15207 / #15252).
			// Wrangler 4.118+ enables local observability capture by default in
			// `wrangler dev`. The extra collector/tail services have crashed the
			// Playwright webServer mid-suite here; opt out for e2e stability.
			X_LOCAL_OBSERVABILITY: 'false',
			// Wrangler 4.127+ local explorer writes under `.wrangler/tmp` on
			// Cloud Agent / CI hosts, retriggers esbuild, and leaves
			// ProxyWorker in a pause/reload loop after Ready.
			X_LOCAL_EXPLORER: 'false',
			// Reduce ProxyWorker "Network connection lost" flakes under e2e load.
			WRANGLER_CI_DISABLE_CONFIG_WATCHING: 'true',
		},
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
})
