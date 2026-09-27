import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	defaultPlaywrightBrowsersJsonPath,
	playwrightCacheRoot,
	playwrightInstallationComplete,
	playwrightLinuxArchiveUrl,
	readChromiumRequirements,
	type PlaywrightBrowserRequirement,
} from './control-kody/playwright-browsers.ts'

export type PlaywrightUnzipCommand = {
	file: string
	args: Array<string>
	label: string
}

export type PlaywrightUnzipPlan =
	| { status: 'already-installed'; detail: string }
	| {
			status: 'install'
			detail: string
			commands: Array<PlaywrightUnzipCommand>
	  }
	| { status: 'error'; detail: string }

export type PlaywrightUnzipRunner = (command: PlaywrightUnzipCommand) => {
	status: number
	stderr?: string
}

export function planPlaywrightBrowsersUnzipInstall(input: {
	homeDir: string
	browsersJsonPath: string
	tmpDir?: string
}): PlaywrightUnzipPlan {
	const requirements = readChromiumRequirements(input.browsersJsonPath)
	if (!requirements.ok) return { status: 'error', detail: requirements.detail }

	const cacheRoot = playwrightCacheRoot(input.homeDir)
	const tmpDir = input.tmpDir ?? os.tmpdir()
	const browsers = [requirements.chromium, requirements.headlessShell]
	const missing = browsers.filter(
		(browser) => !hasInstallationComplete(cacheRoot, browser),
	)
	if (missing.length === 0) {
		return {
			status: 'already-installed',
			detail: `Playwright ${requirements.chromium.directory} and ${requirements.headlessShell.directory} ${playwrightInstallationComplete}`,
		}
	}

	const commands = missing.flatMap((browser) =>
		unzipCommandsForBrowser({ cacheRoot, tmpDir, browser }),
	)
	return {
		status: 'install',
		detail: `Installing Playwright ${missing.map((browser) => browser.directory).join(' and ')} with native unzip.`,
		commands,
	}
}

export function installPlaywrightBrowsersUnzip(
	input: {
		homeDir: string
		browsersJsonPath: string
		tmpDir?: string
	},
	run: PlaywrightUnzipRunner = runUnzipCommand,
) {
	const plan = planPlaywrightBrowsersUnzipInstall(input)
	if (plan.status === 'error') {
		console.error(plan.detail)
		return 1
	}
	if (plan.status === 'already-installed') {
		console.log(plan.detail)
		return 0
	}

	console.log(plan.detail)
	for (const command of plan.commands) {
		console.log(command.label)
		const result = run(command)
		if (result.status !== 0) {
			const stderr = result.stderr?.trim()
			console.error(
				stderr
					? `${command.label} failed: ${stderr}`
					: `${command.label} failed.`,
			)
			return result.status === 0 ? 1 : result.status
		}
	}
	return 0
}

export function isCloudAgentEnvironment(input: {
	homeDir: string
	agentSocketPath?: string
}) {
	const socket =
		input.agentSocketPath ??
		process.env.CURSOR_AGENT_SOCKET ??
		'/run/cursor/api.sock'
	return (
		existsSync(socket) ||
		existsSync(path.join(input.homeDir, '.cursor', 'agent-hooks'))
	)
}

export function shouldInstallPlaywrightBrowsersWithUnzip(input: {
	platform: string
	githubActions: boolean
	cloudAgent: boolean
}) {
	return input.platform === 'linux' && !input.githubActions && input.cloudAgent
}

function unzipCommandsForBrowser(input: {
	cacheRoot: string
	tmpDir: string
	browser: PlaywrightBrowserRequirement
}): Array<PlaywrightUnzipCommand> {
	const dest = path.join(input.cacheRoot, input.browser.directory)
	const zipPath = path.join(
		input.tmpDir,
		`playwright-${input.browser.directory}.zip`,
	)
	const executablePath = path.join(dest, input.browser.executableRelativePath)
	return [
		{
			file: 'mkdir',
			args: ['-p', dest],
			label: `mkdir ${dest}`,
		},
		{
			file: 'curl',
			args: ['-fsSL', '-o', zipPath, playwrightLinuxArchiveUrl(input.browser)],
			label: `curl ${input.browser.archiveName}`,
		},
		{
			file: 'unzip',
			args: ['-q', '-o', zipPath, '-d', dest],
			label: `unzip ${input.browser.archiveName}`,
		},
		{
			file: 'chmod',
			args: ['+x', executablePath],
			label: `chmod +x ${input.browser.executableRelativePath}`,
		},
		{
			file: 'touch',
			args: [path.join(dest, playwrightInstallationComplete)],
			label: `touch ${playwrightInstallationComplete}`,
		},
		{
			file: 'rm',
			args: ['-f', zipPath],
			label: `rm ${input.browser.archiveName}`,
		},
	]
}

function hasInstallationComplete(
	cacheRoot: string,
	browser: PlaywrightBrowserRequirement,
) {
	return existsSync(
		path.join(cacheRoot, browser.directory, playwrightInstallationComplete),
	)
}

function runUnzipCommand(command: PlaywrightUnzipCommand) {
	const result = spawnSync(command.file, command.args, { encoding: 'utf8' })
	return {
		status: result.status ?? 1,
		stderr: result.stderr,
	}
}

if (isExecutedDirectly(import.meta.url)) {
	process.exit(
		installPlaywrightBrowsersUnzip({
			homeDir: os.homedir(),
			browsersJsonPath: defaultPlaywrightBrowsersJsonPath(process.cwd()),
		}),
	)
}
