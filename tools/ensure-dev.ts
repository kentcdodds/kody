import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
	spawnInOwnProcessGroup,
	stopChildProcessTree,
} from './dev-process-utils.ts'
import {
	defaultHealthTimeoutMs,
	defaultWorkerPort,
	findHealthyWorkerOrigin,
	isWorkerHealthOk,
	workerOriginForPort,
	workerPortRange,
} from './dev-server.ts'
import { isExecutedDirectly, resolveNpmCommand } from './node-runtime.ts'

export const defaultReadyTimeoutMs = 180_000
export const defaultReadyPollMs = 500
export const defaultStaleKillWaitMs = 2_000

export type ProcessIdentity = {
	pid: number
	ppid: number
	comm: string
	cmdline: string
}

export type EnsureDevResult =
	| { status: 'reused'; origin: string }
	| { status: 'started'; origin: string; replacedPids: Array<number> }

export type StartedDevHandle = {
	unref: () => void
	stop: () => Promise<void>
	hasExited?: () => boolean
	lastOutput?: () => string
}

export type EnsureDevDeps = {
	ports: ReadonlyArray<number>
	probeHealth: (origin: string) => Promise<boolean>
	listListenerPids: (port: number) => Array<number>
	readProcess: (pid: number) => ProcessIdentity | null
	protectedPids: ReadonlySet<number>
	killProcess: (pid: number, signal: NodeJS.Signals) => void
	startDev: () => StartedDevHandle
	sleep: (ms: number) => Promise<void>
	now: () => number
	readyTimeoutMs: number
	readyPollMs: number
	log: (line: string) => void
}

function normalizeCmdline(cmdline: string) {
	return cmdline.toLowerCase().replaceAll('\0', ' ')
}

export function isWorkerdProcess(identity: { comm: string; cmdline: string }) {
	const comm = identity.comm.toLowerCase()
	const cmdline = normalizeCmdline(identity.cmdline)
	return (
		comm === 'workerd' ||
		comm.includes('workerd') ||
		cmdline.includes('workerd')
	)
}

export function isKodyDevSupervisor(identity: {
	comm: string
	cmdline: string
}) {
	const cmdline = normalizeCmdline(identity.cmdline)
	if (cmdline.includes('ensure-dev')) return false
	if (cmdline.includes('wrangler-env.ts') && cmdline.includes('dev')) {
		return true
	}
	if (cmdline.includes('cli.ts')) return true
	if (/\bnpm\b/.test(cmdline) && /\brun\b/.test(cmdline)) {
		return /(?:^|\s)dev(?::worker)?(?:\s|$)/.test(cmdline)
	}
	return false
}

export function isKodyDevProcess(identity: { comm: string; cmdline: string }) {
	return isWorkerdProcess(identity) || isKodyDevSupervisor(identity)
}

export function hasKodyDevListeners(input: {
	ports: ReadonlyArray<number>
	listListenerPids: (port: number) => Array<number>
	readProcess: (pid: number) => ProcessIdentity | null
	protectedPids: ReadonlySet<number>
}) {
	for (const port of input.ports) {
		for (const pid of input.listListenerPids(port)) {
			if (input.protectedPids.has(pid)) continue
			const identity = input.readProcess(pid)
			if (identity && isKodyDevProcess(identity)) return true
		}
	}
	return false
}

export function isWranglerStillStarting(output: string) {
	const lines = output
		.toLowerCase()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? ''
		if (line.includes('reloading local server')) return true
		if (
			line.includes('local server updated') ||
			line.includes('ready on http')
		) {
			return false
		}
	}
	return false
}

export function collectAncestorPids(
	startPid: number,
	readParentPid: (pid: number) => number | null,
	maxWalk = 12,
) {
	const pids = new Set<number>()
	let pid = startPid
	for (let index = 0; index < maxWalk; index += 1) {
		if (pid <= 1 || pids.has(pid)) break
		pids.add(pid)
		const ppid = readParentPid(pid)
		if (ppid == null || ppid <= 1 || ppid === pid) break
		pid = ppid
	}
	return pids
}

export function collectKodyDevKillPids(input: {
	startPid: number
	readProcess: (pid: number) => ProcessIdentity | null
	protectedPids: ReadonlySet<number>
	maxWalk?: number
}) {
	const maxWalk = input.maxWalk ?? 8
	const chain: Array<{ pid: number; identity: ProcessIdentity }> = []
	let pid = input.startPid
	for (let index = 0; index < maxWalk; index += 1) {
		if (
			pid <= 1 ||
			input.protectedPids.has(pid) ||
			chain.some((entry) => entry.pid === pid)
		) {
			break
		}
		const identity = input.readProcess(pid)
		if (!identity || !isKodyDevProcess(identity)) break
		chain.push({ pid, identity })
		if (identity.ppid <= 1 || identity.ppid === pid) break
		pid = identity.ppid
	}
	if (!chain.some((entry) => isKodyDevSupervisor(entry.identity))) {
		return []
	}
	return chain.map((entry) => entry.pid)
}

export function parseLsofListenPids(stdout: string) {
	const pids = new Set<number>()
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed) continue
		const pid = Number.parseInt(trimmed, 10)
		if (Number.isFinite(pid) && pid > 0) pids.add(pid)
	}
	return [...pids]
}

export function parseSsListenPids(stdout: string) {
	const pids = new Set<number>()
	for (const match of stdout.matchAll(/pid=(\d+)/g)) {
		const pid = Number.parseInt(match[1] ?? '', 10)
		if (Number.isFinite(pid) && pid > 0) pids.add(pid)
	}
	return [...pids]
}

export function readLinuxProcessIdentity(pid: number): ProcessIdentity | null {
	try {
		const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
		const status = readFileSync(`/proc/${pid}/status`, 'utf8')
		const ppidMatch = status.match(/^PPid:\s+(\d+)/m)
		const ppid = Number.parseInt(ppidMatch?.[1] ?? '', 10)
		if (!Number.isFinite(ppid)) return null
		return { pid, ppid, comm, cmdline }
	} catch {
		return null
	}
}

export function listListenerPidsWithCommands(
	port: number,
	run: (command: string, args: Array<string>) => string | null,
) {
	const lsof = run('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-n', '-P', '-t'])
	if (lsof != null) return parseLsofListenPids(lsof)
	const ss = run('ss', ['-lptn', `sport = :${port}`])
	if (ss != null) return parseSsListenPids(ss)
	return []
}

export function resolveNode26BinDir(
	homeDir: string,
	options: {
		readDir?: (dir: string) => Array<string>
		hasNodeBin?: (binDir: string) => boolean
	} = {},
) {
	const readDir = options.readDir ?? ((dir) => readdirSync(dir))
	const hasNodeBin =
		options.hasNodeBin ?? ((binDir) => existsSync(path.join(binDir, 'node')))
	const versionsDir = path.join(homeDir, '.nvm', 'versions', 'node')
	let names: Array<string>
	try {
		names = readDir(versionsDir)
	} catch {
		return null
	}
	const node26 = names
		.filter((name) => name.startsWith('v26.'))
		.sort((left, right) =>
			right.localeCompare(left, undefined, { numeric: true }),
		)
	const binDir = node26
		.map((name) => path.join(versionsDir, name, 'bin'))
		.find((dir) => hasNodeBin(dir))
	return binDir ?? null
}

export function envWithPreferredNode26(
	env: NodeJS.ProcessEnv,
	options: {
		nodeMajor?: number
		homeDir?: string
		readDir?: (dir: string) => Array<string>
		hasNodeBin?: (binDir: string) => boolean
	} = {},
) {
	const nodeMajor =
		options.nodeMajor ?? Number.parseInt(process.versions.node, 10)
	if (Number.isFinite(nodeMajor) && nodeMajor >= 26) return env
	const binDir = resolveNode26BinDir(options.homeDir ?? homedir(), options)
	if (!binDir) return env
	return {
		...env,
		PATH: `${binDir}${path.delimiter}${env.PATH ?? ''}`,
	}
}

export function formatAppRunning(origin: string) {
	return `App running at ${origin}`
}

export async function waitForHealthyOrigin(input: {
	ports: ReadonlyArray<number>
	probeHealth: (origin: string) => Promise<boolean>
	timeoutMs: number
	pollMs: number
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	isCancelled?: () => boolean
}) {
	const now = input.now ?? Date.now
	const sleep = input.sleep ?? delay
	const deadline = now() + input.timeoutMs
	while (now() < deadline) {
		if (input.isCancelled?.()) return null
		const origin = await findHealthyWorkerOrigin(input.ports, {
			probe: input.probeHealth,
		})
		if (origin) return origin
		await sleep(input.pollMs)
	}
	return findHealthyWorkerOrigin(input.ports, { probe: input.probeHealth })
}

export async function replaceStaleKodyListeners(input: {
	ports: ReadonlyArray<number>
	probeHealth: (origin: string) => Promise<boolean>
	listListenerPids: (port: number) => Array<number>
	readProcess: (pid: number) => ProcessIdentity | null
	protectedPids: ReadonlySet<number>
	killProcess: (pid: number, signal: NodeJS.Signals) => void
	sleep: (ms: number) => Promise<void>
	log: (line: string) => void
}) {
	const replaced = new Set<number>()
	for (const port of input.ports) {
		if (await input.probeHealth(workerOriginForPort(port))) continue
		for (const listenerPid of input.listListenerPids(port)) {
			const killPids = collectKodyDevKillPids({
				startPid: listenerPid,
				readProcess: input.readProcess,
				protectedPids: input.protectedPids,
			})
			for (const pid of [...killPids].reverse()) {
				if (replaced.has(pid)) continue
				const identity = input.readProcess(pid)
				input.log(
					`Replaced stale kody listener pid=${pid} comm=${identity?.comm ?? 'unknown'} port=${port}`,
				)
				try {
					input.killProcess(pid, 'SIGTERM')
				} catch {
					// Process may have already exited.
				}
				replaced.add(pid)
			}
		}
	}
	if (replaced.size > 0) {
		await input.sleep(defaultStaleKillWaitMs)
		for (const pid of replaced) {
			const stillThere = input.readProcess(pid)
			if (!stillThere) continue
			try {
				input.killProcess(pid, 'SIGKILL')
			} catch {
				// Process may have already exited.
			}
		}
		await input.sleep(250)
	}
	return [...replaced]
}

export async function ensureDev(deps: EnsureDevDeps): Promise<EnsureDevResult> {
	const existing = await findHealthyWorkerOrigin(deps.ports, {
		probe: deps.probeHealth,
	})
	if (existing) {
		deps.log(formatAppRunning(existing))
		return { status: 'reused', origin: existing }
	}

	if (hasKodyDevListeners(deps)) {
		deps.log(
			'Existing kody listener is not healthy yet; waiting before replacing it.',
		)
		const starting = await waitForHealthyOrigin({
			ports: deps.ports,
			probeHealth: deps.probeHealth,
			timeoutMs: deps.readyTimeoutMs,
			pollMs: deps.readyPollMs,
			now: deps.now,
			sleep: deps.sleep,
		})
		if (starting) {
			deps.log(formatAppRunning(starting))
			return { status: 'reused', origin: starting }
		}
	}

	const replacedPids = await replaceStaleKodyListeners(deps)
	const started = deps.startDev()
	const origin = await waitForHealthyOrigin({
		ports: deps.ports,
		probeHealth: deps.probeHealth,
		timeoutMs: deps.readyTimeoutMs,
		pollMs: deps.readyPollMs,
		now: deps.now,
		sleep: deps.sleep,
		isCancelled: started.hasExited,
	})
	if (!origin) {
		const output = started.lastOutput?.()?.trim() ?? ''
		const stillStarting = Boolean(
			started.hasExited &&
			!started.hasExited() &&
			isWranglerStillStarting(output),
		)
		if (stillStarting) {
			started.unref()
			throw new Error(
				`Local app did not become ready on ${deps.ports[0]}-${deps.ports.at(-1)} within ${deps.readyTimeoutMs}ms; wrangler is still starting. Retry \`npm run dev:ensure\` without killing the process.` +
					(output ? `\n${output}` : ''),
			)
		}
		await started.stop()
		throw new Error(
			`Local app did not become ready on ${deps.ports[0]}-${deps.ports.at(-1)} within ${deps.readyTimeoutMs}ms.` +
				(output ? `\n${output}` : ' Check wrangler output from `npm run dev`.'),
		)
	}
	started.unref()
	deps.log(formatAppRunning(origin))
	return { status: 'started', origin, replacedPids }
}

function runCommandOutput(command: string, args: Array<string>) {
	if (!commandExists(command)) return null
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: 2_000,
	})
	if (result.error) return null
	return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function commandExists(command: string) {
	if (process.platform === 'win32') {
		const result = spawnSync('where', [command], { encoding: 'utf8' })
		return result.status === 0
	}
	const result = spawnSync('sh', ['-c', `command -v ${shellQuote(command)}`], {
		encoding: 'utf8',
	})
	return result.status === 0
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

function defaultListListenerPids(port: number) {
	return listListenerPidsWithCommands(port, runCommandOutput)
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(pid, signal)
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
			return
		}
		throw error
	}
}

function createDefaultStartDev(env: NodeJS.ProcessEnv): StartedDevHandle {
	const child = spawnInOwnProcessGroup(resolveNpmCommand(), ['run', 'dev'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env,
		cwd: process.cwd(),
	})
	const buffered: Array<string> = []
	let exited = false
	const onLine = (chunk: Buffer | string) => {
		const text = chunk.toString()
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue
			buffered.push(line)
			if (buffered.length > 80) buffered.shift()
		}
	}
	child.stdout?.on('data', onLine)
	child.stderr?.on('data', onLine)
	child.once('exit', (code, signal) => {
		exited = true
		if (code && code !== 0) {
			console.error(
				`npm run dev exited (${signal ?? `code ${code}`}). Last output:\n${buffered.join('\n')}`,
			)
		}
	})
	function detachPipes() {
		child.stdout?.removeAllListeners()
		child.stderr?.removeAllListeners()
		child.stdout?.destroy()
		child.stderr?.destroy()
	}
	return {
		hasExited: () => exited || child.exitCode !== null,
		lastOutput: () => buffered.join('\n'),
		unref() {
			detachPipes()
			child.unref()
		},
		async stop() {
			detachPipes()
			await stopChildProcessTree(child)
		},
	}
}

export function createDefaultEnsureDevDeps(
	overrides: Partial<EnsureDevDeps> = {},
): EnsureDevDeps {
	const startPort = Number.parseInt(
		process.env.PORT ?? String(defaultWorkerPort),
		10,
	)
	const ports = overrides.ports ?? workerPortRange(startPort)
	return {
		ports,
		probeHealth: (origin) =>
			isWorkerHealthOk(origin, { timeoutMs: defaultHealthTimeoutMs }),
		listListenerPids: defaultListListenerPids,
		readProcess: readLinuxProcessIdentity,
		protectedPids: collectAncestorPids(process.pid, (pid) => {
			if (pid === process.pid) return process.ppid
			return readLinuxProcessIdentity(pid)?.ppid ?? null
		}),
		killProcess: defaultKillProcess,
		startDev: () => createDefaultStartDev(envWithPreferredNode26(process.env)),
		sleep: delay,
		now: Date.now,
		readyTimeoutMs: defaultReadyTimeoutMs,
		readyPollMs: defaultReadyPollMs,
		log: (line) => {
			console.log(line)
		},
		...overrides,
	}
}

export async function main() {
	const result = await ensureDev(createDefaultEnsureDevDeps())
	return result
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
		.then(() => {
			process.exit(0)
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error)
			process.exit(1)
		})
}
