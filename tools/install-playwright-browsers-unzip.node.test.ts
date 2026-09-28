import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	installPlaywrightBrowsersUnzip,
	isCloudAgentEnvironment,
	planPlaywrightBrowsersUnzipInstall,
	shouldInstallPlaywrightBrowsersWithUnzip,
} from './install-playwright-browsers-unzip.ts'

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
	],
})

test('Cloud Agent Linux uses native unzip and plans curl plus unzip for the browsers.json revision', async () => {
	expect(
		shouldInstallPlaywrightBrowsersWithUnzip({
			platform: 'linux',
			githubActions: false,
			cloudAgent: true,
		}),
	).toBe(true)
	expect(
		shouldInstallPlaywrightBrowsersWithUnzip({
			platform: 'linux',
			githubActions: false,
			cloudAgent: false,
		}),
	).toBe(false)
	expect(
		shouldInstallPlaywrightBrowsersWithUnzip({
			platform: 'linux',
			githubActions: true,
			cloudAgent: true,
		}),
	).toBe(false)
	expect(
		shouldInstallPlaywrightBrowsersWithUnzip({
			platform: 'darwin',
			githubActions: false,
			cloudAgent: true,
		}),
	).toBe(false)

	const homeDir = await mkdtemp(path.join(tmpdir(), 'playwright-unzip-'))
	const tmpDir = path.join(homeDir, 'tmp')
	const browsersJsonPath = path.join(homeDir, 'browsers.json')
	expect(
		isCloudAgentEnvironment({
			homeDir,
			agentSocketPath: path.join(homeDir, 'missing.sock'),
		}),
	).toBe(false)
	await mkdir(path.join(homeDir, '.cursor', 'agent-hooks'), { recursive: true })
	expect(
		isCloudAgentEnvironment({
			homeDir,
			agentSocketPath: path.join(homeDir, 'missing.sock'),
		}),
	).toBe(true)
	const cacheRoot = path.join(homeDir, '.cache', 'ms-playwright')
	try {
		await writeFile(browsersJsonPath, fixtureBrowsersJson)
		await mkdir(path.join(cacheRoot, 'chromium-1208'), { recursive: true })
		await writeFile(
			path.join(cacheRoot, 'chromium-1208', 'INSTALLATION_COMPLETE'),
			'',
		)

		const plan = planPlaywrightBrowsersUnzipInstall({
			homeDir,
			browsersJsonPath,
			tmpDir,
		})
		expect(plan.status).toBe('install')
		if (plan.status !== 'install') return
		expect(plan.detail).toContain('chromium-1234')
		expect(plan.detail).toContain('chromium_headless_shell-1234')
		expect(plan.commands).toEqual([
			{
				file: 'mkdir',
				args: ['-p', path.join(cacheRoot, 'chromium-1234')],
				label: `mkdir ${path.join(cacheRoot, 'chromium-1234')}`,
			},
			{
				file: 'curl',
				args: [
					'-fsSL',
					'-o',
					path.join(tmpDir, 'playwright-chromium-1234.zip'),
					'https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-linux64.zip',
				],
				label: 'curl chrome-linux64.zip',
			},
			{
				file: 'unzip',
				args: [
					'-q',
					'-o',
					path.join(tmpDir, 'playwright-chromium-1234.zip'),
					'-d',
					path.join(cacheRoot, 'chromium-1234'),
				],
				label: 'unzip chrome-linux64.zip',
			},
			{
				file: 'chmod',
				args: [
					'+x',
					path.join(cacheRoot, 'chromium-1234', 'chrome-linux64', 'chrome'),
				],
				label: 'chmod +x chrome-linux64/chrome',
			},
			{
				file: 'touch',
				args: [path.join(cacheRoot, 'chromium-1234', 'INSTALLATION_COMPLETE')],
				label: 'touch INSTALLATION_COMPLETE',
			},
			{
				file: 'rm',
				args: ['-f', path.join(tmpDir, 'playwright-chromium-1234.zip')],
				label: 'rm chrome-linux64.zip',
			},
			{
				file: 'mkdir',
				args: ['-p', path.join(cacheRoot, 'chromium_headless_shell-1234')],
				label: `mkdir ${path.join(cacheRoot, 'chromium_headless_shell-1234')}`,
			},
			{
				file: 'curl',
				args: [
					'-fsSL',
					'-o',
					path.join(tmpDir, 'playwright-chromium_headless_shell-1234.zip'),
					'https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip',
				],
				label: 'curl chrome-headless-shell-linux64.zip',
			},
			{
				file: 'unzip',
				args: [
					'-q',
					'-o',
					path.join(tmpDir, 'playwright-chromium_headless_shell-1234.zip'),
					'-d',
					path.join(cacheRoot, 'chromium_headless_shell-1234'),
				],
				label: 'unzip chrome-headless-shell-linux64.zip',
			},
			{
				file: 'chmod',
				args: [
					'+x',
					path.join(
						cacheRoot,
						'chromium_headless_shell-1234',
						'chrome-headless-shell-linux64',
						'chrome-headless-shell',
					),
				],
				label: 'chmod +x chrome-headless-shell-linux64/chrome-headless-shell',
			},
			{
				file: 'touch',
				args: [
					path.join(
						cacheRoot,
						'chromium_headless_shell-1234',
						'INSTALLATION_COMPLETE',
					),
				],
				label: 'touch INSTALLATION_COMPLETE',
			},
			{
				file: 'rm',
				args: [
					'-f',
					path.join(tmpDir, 'playwright-chromium_headless_shell-1234.zip'),
				],
				label: 'rm chrome-headless-shell-linux64.zip',
			},
		])

		const ran: Array<string> = []
		const status = installPlaywrightBrowsersUnzip(
			{ homeDir, browsersJsonPath, tmpDir },
			(command) => {
				ran.push(`${command.file} ${command.args.join(' ')}`)
				return { status: 0 }
			},
		)
		expect(status).toBe(0)
		expect(ran[0]).toBe(`mkdir -p ${path.join(cacheRoot, 'chromium-1234')}`)
		expect(ran.at(-1)).toBe(
			`rm -f ${path.join(tmpDir, 'playwright-chromium_headless_shell-1234.zip')}`,
		)

		await mkdir(path.join(cacheRoot, 'chromium-1234'), { recursive: true })
		await writeFile(
			path.join(cacheRoot, 'chromium-1234', 'INSTALLATION_COMPLETE'),
			'',
		)
		await mkdir(path.join(cacheRoot, 'chromium_headless_shell-1234'), {
			recursive: true,
		})
		await writeFile(
			path.join(
				cacheRoot,
				'chromium_headless_shell-1234',
				'INSTALLATION_COMPLETE',
			),
			'',
		)
		expect(
			planPlaywrightBrowsersUnzipInstall({
				homeDir,
				browsersJsonPath,
				tmpDir,
			}),
		).toEqual({
			status: 'already-installed',
			detail:
				'Playwright chromium-1234 and chromium_headless_shell-1234 INSTALLATION_COMPLETE',
		})
	} finally {
		await rm(homeDir, { recursive: true, force: true })
	}
})
