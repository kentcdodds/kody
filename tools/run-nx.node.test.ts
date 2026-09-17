import { Writable } from 'node:stream'
import { expect, test } from 'vitest'
import {
	isNxRemoteCacheTransportFailure,
	nxTasksSucceededDespiteRemoteCacheFailure,
	runNxWithRemoteCacheFallback,
	spawnNx,
} from './run-nx.ts'

const cacheTransportFailure = `
 NX  Successfully ran target test-node for project worker

1 skipped

 NX  Failed to send request: error sending request for url (https://nx-cache.kody.codes/v1/cache/6563052018947667317)
`

const cacheTransportFailureBeforeTasks = `
 NX  Failed to send request: error sending request for url (https://nx-cache.kody.codes/v1/cache/6563052018947667317)

Pass --verbose to see the stacktrace.
`

test('isNxRemoteCacheTransportFailure requires the Nx request error and cache path', () => {
	expect(isNxRemoteCacheTransportFailure(cacheTransportFailure)).toBe(true)
	expect(
		isNxRemoteCacheTransportFailure(
			'Failed to send request: error sending request for url (https://example.com/health)',
		),
	).toBe(false)
	expect(
		isNxRemoteCacheTransportFailure(
			'GET https://nx-cache.kody.codes/v1/cache/abc returned 404',
		),
	).toBe(false)
	expect(nxTasksSucceededDespiteRemoteCacheFailure(cacheTransportFailure)).toBe(
		true,
	)
	expect(
		nxTasksSucceededDespiteRemoteCacheFailure(cacheTransportFailureBeforeTasks),
	).toBe(false)
})

test('runNxWithRemoteCacheFallback treats a post-success cache transport flake as success', async () => {
	const attempts: Array<ReadonlyArray<string>> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'https://nx-cache.kody.codes',
		},
		log: (line) => {
			logs.push(line)
		},
		run: (args) => {
			attempts.push(args)
			return {
				status: 1,
				output: cacheTransportFailure,
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([['run', 'worker:test-node']])
	expect(logs.join('\n')).toMatch(/after tasks succeeded/)
})

test('runNxWithRemoteCacheFallback retries once without the remote cache when tasks never finished', async () => {
	const attempts: Array<{
		args: ReadonlyArray<string>
		hasServer: boolean
	}> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'https://nx-cache.kody.codes',
			CI: '1',
		},
		log: () => {},
		run: (args, env) => {
			attempts.push({
				args,
				hasServer: Boolean(env?.NX_SELF_HOSTED_REMOTE_CACHE_SERVER),
			})
			if (attempts.length === 1) {
				return {
					status: 1,
					output: cacheTransportFailureBeforeTasks,
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output: ' NX  Successfully ran target test-node for project worker\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([
		{ args: ['run', 'worker:test-node'], hasServer: true },
		{
			args: ['run', 'worker:test-node', '--skipRemoteCache'],
			hasServer: false,
		},
	])
})

test('runNxWithRemoteCacheFallback does not retry a real task failure', async () => {
	const attempts: Array<number> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'https://nx-cache.kody.codes',
		},
		log: () => {},
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: 'AssertionError: expected true to be false\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
})

test('spawnNx captures stdout from the local nx binary', async () => {
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback()
		},
	})
	const result = await spawnNx(['--version'], undefined, {
		stdout: sink,
		stderr: sink,
	})
	expect(result.status).toBe(0)
	expect(result.output).toMatch(/\d+\.\d+\.\d+/)
})
