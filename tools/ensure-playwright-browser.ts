import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'

const browserExecutablePath = chromium.executablePath()

if (existsSync(browserExecutablePath)) {
	console.log(
		`Playwright Chromium already installed at ${browserExecutablePath}.`,
	)
	process.exit(0)
}

console.log('Installing Playwright Chromium for E2E tests...')

const result = spawnSync(
	'npx',
	['playwright', 'install', 'chromium', '--with-deps'],
	{
		stdio: 'inherit',
		shell: process.platform === 'win32',
	},
)

if (result.status !== 0) {
	process.exit(result.status ?? 1)
}

if (!existsSync(browserExecutablePath)) {
	console.error(
		'Playwright Chromium install completed, but the browser executable is still missing.',
	)
	process.exit(1)
}

console.log(`Playwright Chromium installed at ${browserExecutablePath}.`)
