import { type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import getPort from 'get-port'
import {
	signalChildProcessTree,
	spawnChildProcess,
	stopChildProcessTree,
} from './tools/dev-process-utils.ts'
import { resolveLocalBinary } from './tools/node-runtime.ts'
import { ensureWorkerBundlerModules } from './tools/build-worker-bundler-modules.ts'
import {
	getDefaultWranglerConfigPath,
	jobsWorkerWranglerConfigPath,
	resolveWranglerConfigPath,
} from './tools/wrangler-env-config.ts'
import { writeLocalRuntimeDevConfig } from './tools/local-runtime-dev-config.ts'

const envName = process.env.CLOUDFLARE_ENV ?? 'production'
const portWaitTimeoutMs = 5000
const args = process.argv.slice(2)
const defaultWranglerConfigPath = getDefaultWranglerConfigPath()

const hasEnvFlag = args.includes('--env') || args.includes('-e')
const isDevCommand = args[0] === 'dev'
const hasPortFlag = args.includes('--port')
const hasConfigFlag = args.some(
	(arg) => arg === '--config' || arg.startsWith('--config='),
)
const hasInspectorPortFlag = args.some(
	(arg) => arg === '--inspector-port' || arg.startsWith('--inspector-port='),
)

const commandArgs = [...args]
let shouldAddRuntimeDevConfig = false

if (
	!hasConfigFlag &&
	existsSync(
		resolveWranglerConfigPath(defaultWranglerConfigPath, process.cwd()),
	)
) {
	commandArgs.push('--config', defaultWranglerConfigPath)
	// Multi-worker local dev (ADR 0016): the main worker's JOBS service
	// binding targets the jobs worker, so `wrangler dev` runs both configs
	// together and resolves the service bindings in-process.
	if (
		isDevCommand &&
		existsSync(
			resolveWranglerConfigPath(jobsWorkerWranglerConfigPath, process.cwd()),
		)
	) {
		commandArgs.push('--config', jobsWorkerWranglerConfigPath)
	}
	// Multi-worker local dev (ADR 0016): the main worker's production env
	// binds the runtime worker (RUNTIME_WORKER service binding plus
	// cross-script Durable Objects), so `wrangler dev` runs both scripts in
	// one Miniflare via a secondary --config, which resolves those bindings
	// locally. The secondary config is a generated local-dev variant (see
	// tools/local-runtime-dev-config.ts) because wrangler applies `--var`
	// only to the primary config, registers workers under `<name>-<env>`,
	// and treats a secondary `ai` binding as always-remote.
	const runtimeWorkerConfigPath = 'packages/runtime-worker/wrangler.jsonc'
	// The test env runs the runtime lane in-process (no RUNTIME_WORKER
	// binding), and the runtime config defines no test env.
	if (
		args[0] === 'dev' &&
		envName !== 'test' &&
		existsSync(
			resolveWranglerConfigPath(runtimeWorkerConfigPath, process.cwd()),
		)
	) {
		shouldAddRuntimeDevConfig = true
	}
}

// The main worker config references pre-bundled modules in `src/generated/`
// (see tools/build-worker-bundler-modules.ts), so make sure they exist before
// any wrangler command that builds the worker. Skipped for explicit `--config`
// invocations (mock servers, backup control plane) which don't use them —
// except the runtime worker, whose entry module lives in the same source
// tree as the main worker and imports the same generated modules.
const isWorkerBuildCommand = ['dev', 'build', 'deploy', 'versions'].includes(
	args[0] ?? '',
)
const configArgValue = getArgValue(args, '--config')
const isRuntimeWorkerConfig = Boolean(
	configArgValue?.includes('runtime-worker'),
)
if (isWorkerBuildCommand && (!hasConfigFlag || isRuntimeWorkerConfig)) {
	await ensureWorkerBundlerModules()
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

if (shouldAddRuntimeDevConfig) {
	const runtimeDevConfigPath = await writeLocalRuntimeDevConfig({
		runtimeConfigPath: 'packages/runtime-worker/wrangler.jsonc',
		envName,
		mainWorkerDevName: `kody-${envName}`,
		port: resolvedPort,
	})
	commandArgs.push('--config', runtimeDevConfigPath)
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
		// A signal-initiated shutdown is a normal stop (Ctrl+C, supervisor
		// stop), not a failure; exiting 1 here fails CI steps that stop the
		// dev server deliberately.
		process.exit(0)
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
