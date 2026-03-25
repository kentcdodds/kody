import { type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import getPort from 'get-port'
import { getRemoteAiLocalDevStartupError } from '@kody-internal/shared/ai-env-validation.ts'
import {
	signalChildProcessTree,
	spawnChildProcess,
	stopChildProcessTree,
} from './tools/dev-process-utils.ts'
import { resolveLocalBinary } from './tools/node-runtime.ts'

const envName = process.env.CLOUDFLARE_ENV ?? 'production'
const portWaitTimeoutMs = 5000
const args = process.argv.slice(2)
const defaultWranglerConfigPath = 'packages/worker/wrangler.jsonc'

const hasEnvFlag = args.includes('--env') || args.includes('-e')
const isDevCommand = args[0] === 'dev'
const isLocalDevCommand = isDevCommand && args.includes('--local')
const hasPortFlag = args.includes('--port')
const hasConfigFlag = args.some(
	(arg) => arg === '--config' || arg.startsWith('--config='),
)
const hasInspectorPortFlag = args.some(
	(arg) => arg === '--inspector-port' || arg.startsWith('--inspector-port='),
)

if (isLocalDevCommand) {
	const startupError = getRemoteAiLocalDevStartupError(process.env)
	if (startupError) {
		throw new Error(startupError)
	}
}

const commandArgs = [...args]

if (
	!hasConfigFlag &&
	existsSync(path.join(process.cwd(), defaultWranglerConfigPath))
) {
	commandArgs.push('--config', defaultWranglerConfigPath)
}

if (!hasEnvFlag) {
	commandArgs.push('--env', envName)
}

if (isDevCommand) {
	commandArgs.push('--var', 'WRANGLER_IS_LOCAL_DEV:true')
}

let resolvedPort = process.env.PORT

if (isDevCommand && hasPortFlag) {
	resolvedPort = getPortArg(args) ?? resolvedPort
}

if (isDevCommand && !hasPortFlag) {
	if (process.env.PORT) {
		resolvedPort = process.env.PORT
	} else {
		const desiredPort = 3742
		const portRange = Array.from(
			{ length: 10 },
			(_, index) => desiredPort + index,
		)
		resolvedPort = String(
			await getPort({
				port: portRange,
			}),
		)
	}
	commandArgs.push('--port', resolvedPort)
}

if (isDevCommand && !hasInspectorPortFlag) {
	const parsedPort = resolvedPort ? Number.parseInt(resolvedPort, 10) : NaN
	const inspectorPortRange = Number.isFinite(parsedPort)
		? (() => {
				const preferredBase =
					parsedPort + 10_000 <= 65_535
						? parsedPort + 10_000
						: parsedPort - 10_000
				const safeBase = Math.max(1, preferredBase)
				return Array.from(
					{ length: 10 },
					(_, index) => safeBase + index,
				).filter((port) => port > 0 && port <= 65_535)
			})()
		: undefined
	const resolvedInspectorPort = String(
		await getPort({
			host: '127.0.0.1',
			...(inspectorPortRange ? { port: inspectorPortRange } : {}),
		}),
	)
	commandArgs.push('--inspector-port', resolvedInspectorPort)
}

const processEnv = {
	...process.env,
	CLOUDFLARE_ENV: envName,
	...(resolvedPort ? { PORT: resolvedPort } : {}),
}

const localWranglerPath = path.join(
	process.cwd(),
	'node_modules',
	'.bin',
	process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
)
const wranglerCommand =
	(existsSync(localWranglerPath) && localWranglerPath) ||
	resolveLocalBinary('wrangler')

const proc = spawnChildProcess(wranglerCommand, commandArgs, {
	stdio: ['inherit', 'inherit', 'inherit'],
	env: processEnv,
})
const procExited = createExitPromise(proc)

let isShuttingDown = false

process.once('exit', () => {
	signalChildProcessTree(proc, 'SIGTERM')
})

function handleSignal(signal: NodeJS.Signals) {
	if (isShuttingDown) return
	isShuttingDown = true
	void (async () => {
		await stopChildProcessTree(proc, {
			sigintTimeoutMs: signal === 'SIGINT' ? 5000 : 0,
			sigtermTimeoutMs: 5000,
			sigkillTimeoutMs: 1000,
		})
		process.exit(1)
	})()
}

process.on('SIGINT', () => handleSignal('SIGINT'))
process.on('SIGTERM', () => handleSignal('SIGTERM'))

let exitCode: number | null
try {
	exitCode = await procExited
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
}
if (isDevCommand && resolvedPort) {
	const didFreePort = await waitForPortFree(
		Number.parseInt(resolvedPort, 10),
		portWaitTimeoutMs,
	)
	if (!didFreePort) {
		console.warn(
			`Timed out waiting for port ${resolvedPort} to free up before exit.`,
		)
	}
}
process.exit(exitCode)

function createExitPromise(proc: ChildProcess) {
	return new Promise<number | null>((resolve, reject) => {
		proc.once('error', reject)
		proc.once('exit', (code) => resolve(code))
	})
}

function getPortArg(argumentList: ReadonlyArray<string>) {
	return getArgValue(argumentList, '--port')
}

function getArgValue(argumentList: ReadonlyArray<string>, flagName: string) {
	const inlineArg = argumentList.find((arg) => arg.startsWith(`${flagName}=`))
	if (inlineArg) {
		const separatorIndex = inlineArg.indexOf('=')
		const value =
			separatorIndex >= 0 ? inlineArg.slice(separatorIndex + 1) : undefined
		return value || undefined
	}

	const flagIndex = argumentList.findIndex((arg) => arg === flagName)
	if (flagIndex >= 0) {
		const value = argumentList[flagIndex + 1]
		return value || undefined
	}

	return undefined
}

async function waitForPortFree(port: number, timeoutMs: number) {
	const start = Date.now()
	while (await isPortInUse(port)) {
		if (Date.now() - start >= timeoutMs) {
			return false
		}
		await delay(100)
	}
	return true
}

function isPortInUse(port: number) {
	return new Promise<boolean>((resolve) => {
		const socket = new net.Socket()

		const finish = (inUse: boolean) => {
			socket.removeAllListeners()
			socket.destroy()
			resolve(inUse)
		}

		socket.setTimeout(250)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(true))
		socket.once('error', (error) => {
			if ('code' in error && error.code === 'ECONNREFUSED') {
				finish(false)
				return
			}
			finish(true)
		})

		socket.connect(port, '127.0.0.1')
	})
}
