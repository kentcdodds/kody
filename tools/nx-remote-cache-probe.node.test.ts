import { expect, test } from 'vitest'
import { handleNxCacheRequest } from '../packages/nx-cache/handle-request.ts'
import { createMemoryCacheStore } from '../packages/nx-cache/memory-store.ts'
import {
	envWithoutUnusableNxRemoteCache,
	formatNxRemoteCacheProbe,
	nxRemoteCacheUsable,
	probeNxRemoteCache,
	readProbeHash,
	writeProbeHash,
} from './nx-remote-cache-probe.ts'

const server = 'https://nx-cache.example'

function workerFetch(options?: { failHealth?: boolean }) {
	const store = createMemoryCacheStore()
	const requests: Array<string> = []
	return {
		requests,
		fetch: async (input: string, init?: RequestInit) => {
			const url = new URL(input)
			requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
			if (options?.failHealth && url.pathname === '/health') {
				throw new Error('ECONNREFUSED')
			}
			const headers = new Headers(init?.headers)
			const body = typeof init?.body === 'string' ? init.body : undefined
			const response = await handleNxCacheRequest(
				new Request(url, { method: init?.method ?? 'GET', headers, body }),
				{
					CACHE_ACCESS_TOKEN: 'write-token',
					CACHE_READ_TOKEN: 'read-token',
					BUILD_COMMIT: 'test',
				},
				store,
			)
			return { status: response.status }
		},
	}
}

test('write token reads and writes, and a second probe tolerates 409', async () => {
	const worker = workerFetch()
	const first = await probeNxRemoteCache({
		server: `${server}/`,
		token: 'write-token',
		fetch: worker.fetch,
	})
	expect(first).toEqual({ server, health: 'ok', read: 'ok', write: 'ok' })
	expect(worker.requests).toEqual([
		'GET /health',
		`GET /v1/cache/${readProbeHash}`,
		`PUT /v1/cache/${writeProbeHash}`,
	])
	const second = await probeNxRemoteCache({
		server,
		token: 'write-token',
		fetch: worker.fetch,
	})
	expect(second.write).toBe('ok')
	expect(nxRemoteCacheUsable(second)).toBe(true)
	expect(formatNxRemoteCacheProbe(second)).toBe(
		`Nx remote cache enabled (${server}): token reads and writes.`,
	)
})

test('read token is reported read-only instead of silently dropping uploads', async () => {
	const probe = await probeNxRemoteCache({
		server,
		token: 'read-token',
		fetch: workerFetch().fetch,
	})
	expect(probe).toEqual({
		server,
		health: 'ok',
		read: 'ok',
		write: 'read-only',
	})
	expect(nxRemoteCacheUsable(probe)).toBe(true)
	expect(formatNxRemoteCacheProbe(probe)).toMatch(
		/READ-ONLY: PUT returned 403, so nothing this run computes will be uploaded/,
	)
	expect(
		envWithoutUnusableNxRemoteCache(
			{ NX_SELF_HOSTED_REMOTE_CACHE_SERVER: server },
			probe,
		).NX_SELF_HOSTED_REMOTE_CACHE_SERVER,
	).toBe(server)
})

test('unknown token is unusable so Nx is never pointed at a server that 401s', async () => {
	const worker = workerFetch()
	const probe = await probeNxRemoteCache({
		server,
		token: 'bogus',
		fetch: worker.fetch,
	})
	expect(probe).toEqual({
		server,
		health: 'ok',
		read: 'unauthorized',
		write: 'skipped',
	})
	expect(nxRemoteCacheUsable(probe)).toBe(false)
	expect(worker.requests).not.toContain(`PUT /v1/cache/${writeProbeHash}`)
	expect(formatNxRemoteCacheProbe(probe)).toMatch(
		/rejected the token on GET \(unauthorized\)/,
	)
	const env = {
		NX_SELF_HOSTED_REMOTE_CACHE_SERVER: server,
		NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'bogus',
	}
	const stripped = envWithoutUnusableNxRemoteCache(env, probe)
	expect(stripped.NX_SELF_HOSTED_REMOTE_CACHE_SERVER).toBeUndefined()
	expect(stripped.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN).toBe('bogus')
	expect(env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER).toBe(server)
})

test('unreachable server is skipped without touching the token', async () => {
	const worker = workerFetch({ failHealth: true })
	const probe = await probeNxRemoteCache({
		server,
		token: 'write-token',
		fetch: worker.fetch,
	})
	expect(probe).toEqual({
		server,
		health: 'unreachable',
		read: 'error',
		write: 'skipped',
	})
	expect(nxRemoteCacheUsable(probe)).toBe(false)
	expect(worker.requests).toEqual(['GET /health'])
	expect(formatNxRemoteCacheProbe(probe)).toMatch(/health is unreachable/)
})

test('an unexpected write status is surfaced with its code', async () => {
	const probe = await probeNxRemoteCache({
		server,
		token: 'write-token',
		fetch: async (input, init) => {
			const url = new URL(input)
			if (init?.method === 'PUT') return { status: 500 }
			return { status: url.pathname === '/health' ? 200 : 404 }
		},
	})
	expect(probe.write).toBe('http-500')
	expect(formatNxRemoteCacheProbe(probe)).toMatch(
		/write probe failed \(http-500\); uploads from this run may be lost/,
	)
})
