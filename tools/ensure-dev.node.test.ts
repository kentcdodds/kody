import { expect, test } from 'vitest'
import {
	collectAncestorPids,
	collectKodyDevKillPids,
	ensureDev,
	envWithPreferredNode26,
	isKodyDevProcess,
	parseLsofListenPids,
	parseSsListenPids,
	replaceStaleKodyListeners,
	resolveNode26BinDir,
	waitForHealthyOrigin,
	type ProcessIdentity,
} from './ensure-dev.ts'

test('isKodyDevProcess recognizes leftover wrangler/workerd/cli sessions and ignores others', () => {
	expect(
		isKodyDevProcess({ comm: 'workerd', cmdline: '/opt/workerd --socket' }),
	).toBe(true)
	expect(
		isKodyDevProcess({
			comm: 'node',
			cmdline:
				'node --env-file=packages/worker/.env ./wrangler-env.ts dev --local',
		}),
	).toBe(true)
	expect(
		isKodyDevProcess({
			comm: 'node',
			cmdline: 'node --env-file=packages/worker/.env cli.ts',
		}),
	).toBe(true)
	expect(
		isKodyDevProcess({
			comm: 'npm',
			cmdline: 'npm run dev',
		}),
	).toBe(true)
	expect(
		isKodyDevProcess({
			comm: 'npm',
			cmdline: 'npm run --silent dev:worker',
		}),
	).toBe(true)
	expect(
		isKodyDevProcess({
			comm: 'node',
			cmdline: 'node tools/ensure-dev.ts',
		}),
	).toBe(false)
	expect(
		isKodyDevProcess({
			comm: 'node',
			cmdline: 'node some-other-server.js',
		}),
	).toBe(false)
	expect(
		isKodyDevProcess({
			comm: 'nginx',
			cmdline: 'nginx: master process',
		}),
	).toBe(false)
})

test('collectKodyDevKillPids walks only kody leftovers and never protected ancestors', () => {
	const processes = new Map<number, ProcessIdentity>([
		[40, { pid: 40, ppid: 1, comm: 'bash', cmdline: '-bash' }],
		[41, { pid: 41, ppid: 40, comm: 'npm', cmdline: 'npm run dev' }],
		[
			42,
			{
				pid: 42,
				ppid: 41,
				comm: 'node',
				cmdline: 'node --env-file=packages/worker/.env cli.ts',
			},
		],
		[43, { pid: 43, ppid: 42, comm: 'workerd', cmdline: 'workerd' }],
	])
	expect(
		collectKodyDevKillPids({
			startPid: 43,
			readProcess: (pid) => processes.get(pid) ?? null,
			protectedPids: new Set([40, 99]),
		}),
	).toEqual([43, 42, 41])
	expect(
		collectKodyDevKillPids({
			startPid: 43,
			readProcess: (pid) => processes.get(pid) ?? null,
			protectedPids: new Set([42, 99]),
		}),
	).toEqual([43])
	expect(
		collectAncestorPids(43, (pid) => processes.get(pid)?.ppid ?? null),
	).toEqual(new Set([43, 42, 41, 40]))
})

test('ensureDev reuses a healthy origin without starting or killing', async () => {
	const logs: Array<string> = []
	const started: Array<string> = []
	const killed: Array<string> = []
	const result = await ensureDev({
		ports: [3742, 3743],
		probeHealth: async (origin) => origin === 'http://localhost:3743',
		listListenerPids: () => [99],
		readProcess: () => ({
			pid: 99,
			ppid: 1,
			comm: 'workerd',
			cmdline: 'workerd',
		}),
		protectedPids: new Set([1]),
		killProcess: (pid, signal) => {
			killed.push(`${pid}:${signal}`)
		},
		startDev: () => {
			started.push('start')
			return { unref() {} }
		},
		sleep: async () => {},
		now: () => 0,
		readyTimeoutMs: 1_000,
		readyPollMs: 10,
		log: (line) => {
			logs.push(line)
		},
	})
	expect(result).toEqual({
		status: 'reused',
		origin: 'http://localhost:3743',
	})
	expect(logs).toEqual(['App running at http://localhost:3743'])
	expect(started).toEqual([])
	expect(killed).toEqual([])
})

test('ensureDev replaces a stale workerd leftover then starts until /health is ok', async () => {
	const logs: Array<string> = []
	const killed: Array<string> = []
	let healthy = false
	const processes = new Map<number, ProcessIdentity>([
		[
			700,
			{ pid: 700, ppid: 1, comm: 'workerd', cmdline: 'workerd --port 3742' },
		],
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
			return { unref() {} }
		},
		sleep: async () => {},
		now: () => 0,
		readyTimeoutMs: 1_000,
		readyPollMs: 10,
		log: (line) => {
			logs.push(line)
		},
	})
	expect(result).toEqual({
		status: 'started',
		origin: 'http://localhost:3742',
		replacedPids: [700],
	})
	expect(killed).toEqual(['700'])
	expect(logs[0]).toBe(
		'Replaced stale kody listener pid=700 comm=workerd port=3742',
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
		now: (() => {
			let t = 0
			return () => {
				t += 1
				return t
			}
		})(),
		sleep: async () => {},
	})
	expect(origin).toBe('http://localhost:3742')

	const missed = await waitForHealthyOrigin({
		ports: [3742],
		probeHealth: async () => false,
		timeoutMs: 2,
		pollMs: 1,
		now: (() => {
			let t = 0
			return () => {
				t += 1
				return t
			}
		})(),
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
	expect(
		envWithPreferredNode26(
			{ PATH: '/exec-daemon:/usr/bin' },
			{ nodeMajor: 26, homeDir, readDir, hasNodeBin },
		).PATH,
	).toBe('/exec-daemon:/usr/bin')
	expect(
		envWithPreferredNode26(
			{ PATH: '/exec-daemon:/usr/bin' },
			{ nodeMajor: 22, homeDir, readDir, hasNodeBin },
		).PATH,
	).toBe('/home/agent/.nvm/versions/node/v26.7.0/bin:/exec-daemon:/usr/bin')

	const binDir = resolveNode26BinDir(homeDir, {
		readDir: () => ['v26.7.0'],
		hasNodeBin: () => true,
	})
	expect(binDir).toBe('/home/agent/.nvm/versions/node/v26.7.0/bin')
})
