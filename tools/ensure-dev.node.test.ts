import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	appendDevOutputChunk,
	collectAncestorPids,
	collectKodyDevKillPids,
	ensureDev,
	ensureWorkerEnvFile,
	envWithPreferredNode26,
	formatDevServerLogPath,
	formatMissingWranglerBindingHint,
	isKodyDevProcess,
	isMissingWranglerBindingOutput,
	joinDevOutput,
	isKodyDevSupervisor,
	isWranglerStillStarting,
	parseLsofListenPids,
	parseSsListenPids,
	replaceStaleKodyListeners,
	resolveDevServerLogPath,
	resolveNode26BinDir,
	tailDevServerLog,
	waitForHealthyOrigin,
	type ProcessIdentity,
} from './ensure-dev.ts'

type EnsureDevOptions = Parameters<typeof ensureDev>[0]
type DevChild = ReturnType<EnsureDevOptions['startDev']>

/** A monotonic clock that advances one ms per read. */
function ticker() {
	let t = 0
	return () => {
		t += 1
		return t
	}
}

const workerd = (pid: number, ppid = 1): ProcessIdentity => ({
	pid,
	ppid,
	comm: 'workerd',
	cmdline: 'workerd --port 3742',
})
const kodyCli = 'node --env-file=packages/worker/.env cli.ts'
const waitingLog =
	'Existing kody listener is not healthy yet; waiting before replacing it.'

function recorder() {
	const logs: Array<string> = []
	const killed: Array<string> = []
	const started: Array<string> = []
	return {
		logs,
		killed,
		started,
		log: (line: string) => {
			logs.push(line)
		},
		killProcess: (pid: number) => {
			killed.push(String(pid))
		},
		startDev: (): DevChild => {
			started.push('start')
			return { unref() {}, async stop() {} }
		},
	}
}

test('isKodyDevProcess recognizes leftover wrangler/workerd/cli sessions and ignores others', () => {
	const cases: Array<[string, string, boolean]> = [
		['workerd', '/opt/workerd --socket', true],
		[
			'node',
			'node --env-file=packages/worker/.env ./wrangler-env.ts dev --local',
			true,
		],
		['node', kodyCli, true],
		['npm', 'npm run dev', true],
		['npm', 'npm run --silent dev:worker', true],
		['node', 'node tools/ensure-dev.ts', false],
		['node', 'node some-other-server.js', false],
		['nginx', 'nginx: master process', false],
	]
	expect(
		cases.filter(
			([comm, cmdline, want]) => isKodyDevProcess({ comm, cmdline }) !== want,
		),
	).toEqual([])
	expect(
		isKodyDevSupervisor({ comm: 'workerd', cmdline: 'workerd --socket' }),
	).toBe(false)
	expect(isKodyDevSupervisor({ comm: 'node', cmdline: kodyCli })).toBe(true)
})

test('collectKodyDevKillPids walks only kody leftovers and never protected ancestors', () => {
	const processes = new Map<number, ProcessIdentity>([
		[40, { pid: 40, ppid: 1, comm: 'bash', cmdline: '-bash' }],
		[41, { pid: 41, ppid: 40, comm: 'npm', cmdline: 'npm run dev' }],
		[42, { pid: 42, ppid: 41, comm: 'node', cmdline: kodyCli }],
		[43, { pid: 43, ppid: 42, comm: 'workerd', cmdline: 'workerd' }],
	])
	const readProcess = (pid: number) => processes.get(pid) ?? null
	expect(
		collectKodyDevKillPids({
			startPid: 43,
			readProcess,
			protectedPids: new Set([40, 99]),
		}),
	).toEqual([43, 42, 41])
	expect(
		collectKodyDevKillPids({
			startPid: 43,
			readProcess,
			protectedPids: new Set([42, 99]),
		}),
	).toEqual([])
	expect(
		collectKodyDevKillPids({
			startPid: 700,
			readProcess: () => workerd(700),
			protectedPids: new Set([1]),
		}),
	).toEqual([])
	expect(
		collectAncestorPids(43, (pid) => processes.get(pid)?.ppid ?? null),
	).toEqual(new Set([43, 42, 41, 40]))
})

test('ensureDev reuses a healthy origin, or waits for a reloading kody listener, without starting or killing', async () => {
	const healthy = recorder()
	expect(
		await ensureDev({
			ports: [3742, 3743],
			probeHealth: async (origin) => origin === 'http://localhost:3743',
			listListenerPids: () => [99],
			readProcess: () => ({ ...workerd(99), cmdline: 'workerd' }),
			protectedPids: new Set([1]),
			killProcess: healthy.killProcess,
			startDev: healthy.startDev,
			sleep: async () => {},
			now: () => 0,
			readyTimeoutMs: 1_000,
			readyPollMs: 10,
			log: healthy.log,
		}),
	).toEqual({ status: 'reused', origin: 'http://localhost:3743' })
	expect(healthy.logs).toEqual(['App running at http://localhost:3743'])
	expect(healthy.started).toEqual([])
	expect(healthy.killed).toEqual([])

	const reloading = recorder()
	let isHealthy = false
	expect(
		await ensureDev({
			ports: [3742],
			probeHealth: async () => isHealthy,
			listListenerPids: () => [700],
			readProcess: () => workerd(700),
			protectedPids: new Set([1]),
			killProcess: reloading.killProcess,
			startDev: reloading.startDev,
			sleep: async () => {
				isHealthy = true
			},
			now: ticker(),
			readyTimeoutMs: 10,
			readyPollMs: 1,
			log: reloading.log,
		}),
	).toEqual({ status: 'reused', origin: 'http://localhost:3742' })
	expect(reloading.started).toEqual([])
	expect(reloading.killed).toEqual([])
	expect(reloading.logs[0]).toBe(waitingLog)
	expect(reloading.logs.at(-1)).toBe('App running at http://localhost:3742')
})

test('ensureDev replaces a stale workerd leftover then starts until /health is ok', async () => {
	const { logs, killed, log } = recorder()
	let healthy = false
	const processes = new Map<number, ProcessIdentity>([
		[699, { pid: 699, ppid: 1, comm: 'npm', cmdline: 'npm run dev' }],
		[700, workerd(700, 699)],
	])
	const result = await ensureDev({
		ports: [3742],
		probeHealth: async () => healthy,
		listListenerPids: (port) =>
			port === 3742 && processes.has(700) ? [700] : [],
		readProcess: (pid) => processes.get(pid) ?? null,
		protectedPids: new Set([1, process.pid]),
		killProcess: (pid) => {
			killed.push(String(pid))
			processes.delete(pid)
		},
		startDev: () => {
			healthy = true
			return { unref() {}, async stop() {} }
		},
		sleep: async () => {},
		now: ticker(),
		readyTimeoutMs: 10,
		readyPollMs: 1,
		log,
	})
	expect(result).toEqual({
		status: 'started',
		origin: 'http://localhost:3742',
		replacedPids: [699, 700],
	})
	expect(killed).toEqual(['699', '700'])
	expect(logs[0]).toBe(waitingLog)
	expect(logs).toContain(
		'Replaced stale kody listener pid=699 comm=npm port=3742',
	)
	expect(logs.at(-1)).toBe('App running at http://localhost:3742')
})

test('replaceStaleKodyListeners leaves a non-kody occupant on the port', async () => {
	const killed: Array<number> = []
	const replaced = await replaceStaleKodyListeners({
		ports: [3742],
		probeHealth: async () => false,
		listListenerPids: () => [55],
		readProcess: () => ({
			pid: 55,
			ppid: 1,
			comm: 'nginx',
			cmdline: 'nginx: master process',
		}),
		protectedPids: new Set([1]),
		killProcess: (pid) => {
			killed.push(pid)
		},
		sleep: async () => {},
		log: () => {},
	})
	expect(replaced).toEqual([])
	expect(killed).toEqual([])
})

test('waitForHealthyOrigin polls until /health responds or the budget ends', async () => {
	let calls = 0
	const origin = await waitForHealthyOrigin({
		ports: [3742],
		probeHealth: async () => {
			calls += 1
			return calls >= 3
		},
		timeoutMs: 1_000,
		pollMs: 1,
		now: ticker(),
		sleep: async () => {},
	})
	expect(origin).toBe('http://localhost:3742')

	const missed = await waitForHealthyOrigin({
		ports: [3742],
		probeHealth: async () => false,
		timeoutMs: 2,
		pollMs: 1,
		now: ticker(),
		sleep: async () => {},
	})
	expect(missed).toBeNull()
})

test('lsof and ss listener pid parsers ignore junk', () => {
	expect(parseLsofListenPids('700\n701\n\nbad\n700\n')).toEqual([700, 701])
	expect(
		parseSsListenPids(
			'LISTEN 0 511 127.0.0.1:3742 0.0.0.0:* users:(("workerd",pid=700,fd=3))\n',
		),
	).toEqual([700])
})

test('envWithPreferredNode26 prepends nvm Node 26 only when the current runtime is older', () => {
	const homeDir = '/home/agent'
	const readDir = (dir: string) => {
		expect(dir).toBe('/home/agent/.nvm/versions/node')
		return ['v22.17.0', 'v26.7.0', 'v26.4.0']
	}
	const hasNodeBin = () => true
	const pathFor = (nodeMajor: number) =>
		envWithPreferredNode26(
			{ PATH: '/exec-daemon:/usr/bin' },
			{ nodeMajor, homeDir, readDir, hasNodeBin },
		).PATH
	expect(pathFor(26)).toBe('/exec-daemon:/usr/bin')
	expect(pathFor(22)).toBe(
		'/home/agent/.nvm/versions/node/v26.7.0/bin:/exec-daemon:/usr/bin',
	)
	expect(
		resolveNode26BinDir(homeDir, {
			readDir: () => ['v26.7.0'],
			hasNodeBin: () => true,
		}),
	).toBe('/home/agent/.nvm/versions/node/v26.7.0/bin')
})

test('ensureWorkerEnvFile copies .env.example once and refuses when both are missing', () => {
	const copied: Array<string> = []
	const present = new Set(['/repo/packages/worker/.env.example'])
	const created = ensureWorkerEnvFile('/repo', {
		exists: (file) => present.has(file),
		copyFile: (from, to) => {
			copied.push(`${from}->${to}`)
			present.add(to)
		},
	})
	expect(created).toEqual({ created: true, path: '/repo/packages/worker/.env' })
	expect(copied).toEqual([
		'/repo/packages/worker/.env.example->/repo/packages/worker/.env',
	])
	expect(
		ensureWorkerEnvFile('/repo', {
			exists: (file) => present.has(file),
			copyFile: () => {
				throw new Error('should not copy again')
			},
		}).created,
	).toBe(false)
	expect(() =>
		ensureWorkerEnvFile('/empty', { exists: () => false, copyFile: () => {} }),
	).toThrow(/\.env\.example is not present/)
})

test('ensureDev stops or keeps a started child that never becomes healthy based on its output', async () => {
	const cases: Array<{
		lastOutput: string
		hasExited?: boolean
		readyTimeoutMs: number
		error: RegExp
		stopped: boolean
	}> = [
		// Missing bindings fail immediately rather than waiting out the budget.
		{
			lastOutput:
				'Invalid environment variables: APP_DB: Missing APP_DB binding for database access',
			readyTimeoutMs: 180_000,
			error: /fails immediately instead of waiting 180s/,
			stopped: true,
		},
		// /health never ready: stop the child and surface its output.
		{
			lastOutput: 'Reloading local server...',
			readyTimeoutMs: 2,
			error: /Reloading local server/,
			stopped: true,
		},
		// A still-starting wrangler is left running (unref'd).
		{
			lastOutput: 'Local server updated and ready\nReloading local server...',
			hasExited: false,
			readyTimeoutMs: 2,
			error: /still starting/,
			stopped: false,
		},
		// Claimed Ready but never healthy: stop it.
		{
			lastOutput:
				'Local server updated and ready\nReady on http://localhost:3742',
			hasExited: false,
			readyTimeoutMs: 2,
			error: /did not become ready/,
			stopped: true,
		},
	]
	for (const {
		lastOutput,
		hasExited,
		readyTimeoutMs,
		error,
		stopped,
	} of cases) {
		const calls: Array<string> = []
		await expect(
			ensureDev({
				ports: [3742],
				probeHealth: async () => false,
				listListenerPids: () => [],
				readProcess: () => null,
				protectedPids: new Set([1]),
				killProcess: () => {},
				startDev: () => ({
					unref() {
						calls.push('unref')
					},
					async stop() {
						calls.push('stop')
					},
					...(hasExited === undefined ? {} : { hasExited: () => hasExited }),
					lastOutput: () => lastOutput,
				}),
				sleep: async () => {},
				now: ticker(),
				readyTimeoutMs,
				readyPollMs: 1,
				log: () => {},
			}),
		).rejects.toThrow(error)
		expect(calls).toEqual(stopped ? ['stop'] : ['unref'])
	}

	const stillStarting: Array<[string, boolean]> = [
		['Local server updated and ready\nReloading local server...', true],
		['Ready on http://localhost:3742', false],
		['Reloading local server...\nReady on http://localhost:3742', false],
		['Cannot apply deleted_classes migration', false],
	]
	expect(
		stillStarting.filter(
			([output, want]) => isWranglerStillStarting(output) !== want,
		),
	).toEqual([])
	expect(
		isMissingWranglerBindingOutput(
			'Invalid environment variables: APP_DB: Missing APP_DB binding',
		),
	).toBe(true)
	expect(
		formatMissingWranglerBindingHint('APP_DB missing').toLowerCase(),
	).toContain('cloud agent')
})

test('dev output matching keeps a split fatal phrase across chunks and interleaved streams', () => {
	const buffered: Array<string> = []
	const state = { pending: '' }
	appendDevOutputChunk(buffered, state, 'Invalid environment vari')
	expect(
		isMissingWranglerBindingOutput(joinDevOutput(buffered, state.pending)),
	).toBe(false)
	appendDevOutputChunk(
		buffered,
		state,
		'ables: APP_DB: Missing APP_DB binding for database access\n',
	)
	expect(
		isMissingWranglerBindingOutput(joinDevOutput(buffered, state.pending)),
	).toBe(true)

	const interleaved: Array<string> = []
	const stdout = { pending: '' }
	const stderr = { pending: '' }
	appendDevOutputChunk(interleaved, stdout, 'Invalid environment vari')
	appendDevOutputChunk(interleaved, stderr, 'vite optimizing deps...\n')
	appendDevOutputChunk(
		interleaved,
		stdout,
		'ables: APP_DB: Missing APP_DB binding for database access\n',
	)
	expect(
		isMissingWranglerBindingOutput(
			joinDevOutput(interleaved, stdout.pending, stderr.pending),
		),
	).toBe(true)
})

test('dev:ensure names a durable log file agents can read after detach', () => {
	expect(resolveDevServerLogPath('/repo')).toBe('/repo/.tmp/dev-server.log')
	expect(formatDevServerLogPath('/repo/.tmp/dev-server.log')).toBe(
		'Dev server log: /repo/.tmp/dev-server.log',
	)
	expect(tailDevServerLog('/repo/.tmp/missing-dev-server.log')).toBe('')
	const logFile = path.join(
		mkdtempSync(path.join(tmpdir(), 'dev-log-')),
		'dev-server.log',
	)
	writeFileSync(logFile, 'one\n\ntwo\nthree\n')
	expect(tailDevServerLog(logFile)).toBe('one\ntwo\nthree')
})
