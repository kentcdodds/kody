import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { chromium } from '@playwright/test'
import { defaultPlaywrightBrowsersJsonPath } from './control-kody/playwright-browsers.ts'
import {
	installPlaywrightBrowsersUnzip,
	isCloudAgentEnvironment,
	shouldInstallPlaywrightBrowsersWithUnzip,
} from './install-playwright-browsers-unzip.ts'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'

export function playwrightChromiumInstallArgs(input: {
	githubActions: boolean
}): Array<string> {
	// GitHub-hosted runners already have the system libraries. `--with-deps`
	// runs `apt-get update` on every E2E job and can hang past the 15-minute
	// Validate timeout. Local Linux still needs the dep install.
	if (input.githubActions) {
		return ['install', 'chromium']
	}
	return ['install', 'chromium', '--with-deps']
}

export function ensurePlaywrightChromium(
	input: {
		homeDir?: string
		browsersJsonPath?: string
		platform?: string
		githubActions?: boolean
		cloudAgent?: boolean
	} = {},
) {
	const homeDir = input.homeDir ?? os.homedir()
	const browsersJsonPath =
		input.browsersJsonPath ?? defaultPlaywrightBrowsersJsonPath(process.cwd())
	const githubActions =
		input.githubActions ?? process.env.GITHUB_ACTIONS === 'true'
	const cloudAgent = input.cloudAgent ?? isCloudAgentEnvironment({ homeDir })

	if (
		shouldInstallPlaywrightBrowsersWithUnzip({
			platform: input.platform ?? process.platform,
			githubActions,
			cloudAgent,
		})
	) {
		return installPlaywrightBrowsersUnzip({ homeDir, browsersJsonPath })
	}

	const browserExecutablePath = chromium.executablePath()
	if (existsSync(browserExecutablePath)) {
		console.log(
			`Playwright Chromium already installed at ${browserExecutablePath}.`,
		)
		return 0
	}

	const installArgs = playwrightChromiumInstallArgs({ githubActions })
	console.log(
		`Installing Playwright Chromium for E2E tests (${installArgs.join(' ')})...`,
	)

	const result = spawnSync(resolveLocalBinary('playwright'), installArgs, {
		stdio: 'inherit',
		shell: process.platform === 'win32',
	})
	if (result.status !== 0) {
		return result.status ?? 1
	}

	if (!existsSync(browserExecutablePath)) {
		console.error(
			'Playwright Chromium install completed, but the browser executable is still missing.',
		)
		return 1
	}

	console.log(`Playwright Chromium installed at ${browserExecutablePath}.`)
	return 0
}

if (isExecutedDirectly(import.meta.url)) {
	process.exit(ensurePlaywrightChromium())
}
