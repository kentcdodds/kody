import { type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import getPort from 'get-port'
import {
	signalChildProcessTree,
	spawnInOwnProcessGroup,
	stopChildProcessTree,
} from './dev-process-utils.ts'
import { resolveLocalBinary } from './node-runtime.ts'

const defaultPlaywrightPort = 3847
const args = process.argv.slice(2)

const resolvedPlaywrightPort =
	process.env.PLAYWRIGHT_PORT ??
	String(
		await getPort({
			port: Array.from(
				{ length: 20 },
				(_, index) => defaultPlaywrightPort + index,
			),
		}),
	)
const createdTempPersistPath = !process.env.PLAYWRIGHT_PERSIST_PATH
const resolvedPlaywrightPersistPath =
	process.env.PLAYWRIGHT_PERSIST_PATH ??
	mkdtempSync(path.join(tmpdir(), 'kody-playwright-state-'))

const playwrightCommand = resolvePlaywrightCommand()
const child = spawnInOwnProcessGroup(playwrightCommand, ['test', ...args], {
	stdio: 'inherit',
	env: {
		...process.env,
		PLAYWRIGHT_PORT: resolvedPlaywrightPort,
		PLAYWRIGHT_PERSIST_PATH: resolvedPlaywrightPersistPath,
	},
})

const exitCode = await run()
process.exit(exitCode)

function resolvePlaywrightCommand() {
	const localBinary = path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
	)
	if (existsSync(localBinary)) {
		return localBinary
	}

	return resolveLocalBinary('playwright')
}

async function run() {
	let isShuttingDown = false
	let didRegisterExitCleanup = true

	process.once('exit', () => {
		if (!didRegisterExitCleanup) return
		signalChildProcessTree(child, 'SIGTERM')
		cleanupPersistPath()
	})

	const shutdown = async (exitCode: number) => {
		if (isShuttingDown) return
		isShuttingDown = true
		didRegisterExitCleanup = false
		await stopChildProcessTree(child)
		cleanupPersistPath()
		process.exit(exitCode)
	}

	process.on('SIGINT', () => {
		void shutdown(130)
	})
	process.on('SIGTERM', () => {
		void shutdown(143)
	})
	process.on('uncaughtException', (error) => {
		console.error(error)
		void shutdown(1)
	})
	process.on('unhandledRejection', (error) => {
		console.error(error)
		void shutdown(1)
	})

	try {
		const exitCode = await waitForExit(child)
		didRegisterExitCleanup = false
		return exitCode
	} finally {
		cleanupPersistPath()
	}
}

function waitForExit(child: ChildProcess) {
	return new Promise<number>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (signal) {
				resolve(1)
				return
			}
			resolve(code ?? 0)
		})
	})
}

function cleanupPersistPath() {
	if (!createdTempPersistPath) return

	try {
		rmSync(resolvedPlaywrightPersistPath, { recursive: true, force: true })
	} catch {
		// Best effort cleanup for per-run E2E state.
	}
}
