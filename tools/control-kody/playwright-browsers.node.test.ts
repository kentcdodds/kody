import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	defaultPlaywrightBrowsersJsonPath,
	inspectPlaywrightBrowsers,
} from './playwright-browsers.ts'

const fixtureBrowsersJson = JSON.stringify({
	browsers: [
		{
			name: 'chromium',
			revision: '1234',
			installByDefault: true,
			browserVersion: '151.0.7922.34',
		},
		{
			name: 'chromium-headless-shell',
			revision: '1234',
			installByDefault: true,
			browserVersion: '151.0.7922.34',
		},
		{
			name: 'firefox',
			revision: '1538',
			installByDefault: true,
			browserVersion: '153.0',
		},
	],
})

test('doctor requires the browsers.json chromium revision, not any INSTALLATION_COMPLETE marker', async () => {
	const homeDir = await mkdtemp(path.join(tmpdir(), 'playwright-browsers-'))
	const browsersJsonPath = path.join(homeDir, 'browsers.json')
	const cacheRoot = path.join(homeDir, '.cache', 'ms-playwright')
	const repoRoot = path.resolve(import.meta.dirname, '../..')
	try {
		const missingFile = inspectPlaywrightBrowsers({
			homeDir,
			browsersJsonPath,
		})
		expect(missingFile).toEqual({
			ok: false,
			detail: `Cannot read ${browsersJsonPath}. Doctor cannot verify the Playwright browser revision.`,
		})

		await writeFile(browsersJsonPath, '{')
		expect(inspectPlaywrightBrowsers({ homeDir, browsersJsonPath })).toEqual({
			ok: false,
			detail: `Cannot parse ${browsersJsonPath} as playwright-core browsers.json. Doctor cannot verify the Playwright browser revision.`,
		})

		await writeFile(browsersJsonPath, JSON.stringify({ browsers: [] }))
		expect(
			inspectPlaywrightBrowsers({ homeDir, browsersJsonPath }).detail,
		).toBe(
			`${browsersJsonPath} has no chromium entry. Doctor cannot verify the Playwright browser revision.`,
		)

		await writeFile(browsersJsonPath, fixtureBrowsersJson)
		await writeMarker(cacheRoot, 'chromium-1208')
		await writeMarker(cacheRoot, 'chromium_headless_shell-1208')
		const stale = inspectPlaywrightBrowsers({ homeDir, browsersJsonPath })
		expect(stale.ok).toBe(false)
		expect(stale.detail).toBe(
			missingDetail(cacheRoot, 'chromium-1234, chromium_headless_shell-1234'),
		)

		await mkdir(path.join(cacheRoot, 'chromium-1234'), { recursive: true })
		await writeMarker(cacheRoot, 'chromium_headless_shell-1234')
		expect(
			inspectPlaywrightBrowsers({ homeDir, browsersJsonPath }).detail,
		).toBe(missingDetail(cacheRoot, 'chromium-1234'))

		await writeMarker(cacheRoot, 'chromium-1234')
		expect(inspectPlaywrightBrowsers({ homeDir, browsersJsonPath })).toEqual({
			ok: true,
			detail:
				'Playwright chromium-1234 and chromium_headless_shell-1234 INSTALLATION_COMPLETE',
		})

		const installed = JSON.parse(
			readFileSync(defaultPlaywrightBrowsersJsonPath(repoRoot), 'utf8'),
		) as { browsers: Array<{ name: string; revision: string }> }
		const revision = installed.browsers.find(
			(browser) => browser.name === 'chromium',
		)?.revision
		const emptyHome = path.join(homeDir, 'empty-home')
		await mkdir(emptyHome)
		const realCatalog = inspectPlaywrightBrowsers({
			homeDir: emptyHome,
			browsersJsonPath: defaultPlaywrightBrowsersJsonPath(repoRoot),
		})
		expect(realCatalog.ok).toBe(false)
		expect(realCatalog.detail).toContain(`chromium-${revision}`)
		expect(realCatalog.detail).toContain(`chromium_headless_shell-${revision}`)
		expect(realCatalog.detail).toContain(
			'Do not run playwright install on this VM.',
		)
		expect(realCatalog.detail).toContain('docs/contributing/cloud-agents.md')
		expect(realCatalog.detail).toContain('chrome-linux64.zip')
		expect(realCatalog.detail).toContain('chrome-headless-shell-linux64.zip')
	} finally {
		await rm(homeDir, { recursive: true, force: true })
	}
})

function missingDetail(cacheRoot: string, missingDirectories: string) {
	const chromeZip =
		'https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-linux64.zip'
	const headlessZip =
		'https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip'
	return `Playwright revision missing (${missingDirectories}). Required chromium-1234 and chromium_headless_shell-1234. Do not run playwright install on this VM. Unzip per docs/contributing/cloud-agents.md: curl ${chromeZip} and ${headlessZip}, unzip into ${path.join(cacheRoot, 'chromium-1234')} and ${path.join(cacheRoot, 'chromium_headless_shell-1234')}, touch INSTALLATION_COMPLETE in each directory, and chmod +x the chrome and chrome-headless-shell binaries.`
}

async function writeMarker(cacheRoot: string, directory: string) {
	const browserDirectory = path.join(cacheRoot, directory)
	await mkdir(browserDirectory, { recursive: true })
	await writeFile(path.join(browserDirectory, 'INSTALLATION_COMPLETE'), '')
}
