import { expect, test } from 'vitest'
import { playwrightChromiumInstallArgs } from './ensure-playwright-browser.ts'

test('Playwright Chromium install skips apt deps on GitHub Actions and keeps them locally', () => {
	expect(playwrightChromiumInstallArgs({ githubActions: true })).toEqual([
		'install',
		'chromium',
	])
	expect(playwrightChromiumInstallArgs({ githubActions: false })).toEqual([
		'install',
		'chromium',
		'--with-deps',
	])
})
