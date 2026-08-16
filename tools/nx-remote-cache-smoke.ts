import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isExecutedDirectly } from './node-runtime.ts'
import { startLocalNxCacheServer } from '../packages/nx-cache/local-server.ts'

const PROBE_OUTPUT = '.tmp/nx-cache-smoke-probe.txt'

function runNxSmokeProbe(env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; output: string }>((resolve, reject) => {
		const child = spawn(
			'npx',
			['nx', 'run', 'nx-cache:smoke-probe', '--skip-nx-cache=false'],
			{
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		let output = ''
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString()
		})
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString()
		})
		child.on('error', reject)
		child.on('close', (code) => {
			resolve({ code: code ?? 1, output })
		})
	})
}

async function wipeIsolatedLocalState(
	cacheDirectory: string,
	workspaceDataDirectory: string,
) {
	await rm(cacheDirectory, { recursive: true, force: true })
	await mkdir(cacheDirectory, { recursive: true })
	await rm(workspaceDataDirectory, { recursive: true, force: true })
	await mkdir(workspaceDataDirectory, { recursive: true })
	await rm(PROBE_OUTPUT, { force: true })
}

export async function runNxRemoteCacheSmoke() {
	const isolatedRoot = await mkdtemp(join(tmpdir(), 'nx-cache-smoke-'))
	const cacheDirectory = join(isolatedRoot, 'cache')
	const workspaceDataDirectory = join(isolatedRoot, 'workspace-data')
	await mkdir(cacheDirectory, { recursive: true })
	await mkdir(workspaceDataDirectory, { recursive: true })

	await using server = {
		...(await startLocalNxCacheServer()),
		async [Symbol.asyncDispose]() {
			await this.close()
			await rm(isolatedRoot, { recursive: true, force: true })
		},
	}

	const env = {
		...process.env,
		NX_DAEMON: 'false',
		NX_CACHE_DIRECTORY: cacheDirectory,
		NX_WORKSPACE_DATA_DIRECTORY: workspaceDataDirectory,
		NX_PROJECT_GRAPH_CACHE_DIRECTORY: workspaceDataDirectory,
		NX_SELF_HOSTED_REMOTE_CACHE_SERVER: server.url,
		NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: server.token,
		NX_CACHE_SMOKE_FAIL_IF_RUN: '',
	}

	await wipeIsolatedLocalState(cacheDirectory, workspaceDataDirectory)
	const first = await runNxSmokeProbe(env)
	if (first.code !== 0) {
		throw new Error(`First smoke-probe failed:\n${first.output}`)
	}
	const firstPuts = server.requests.filter(
		(entry) => entry.method === 'PUT' && entry.status === 200,
	)
	if (firstPuts.length === 0) {
		throw new Error(
			`Nx did not PUT a cache artifact.\nRequests: ${JSON.stringify(server.requests)}\n${first.output}`,
		)
	}

	await wipeIsolatedLocalState(cacheDirectory, workspaceDataDirectory)
	const second = await runNxSmokeProbe({
		...env,
		NX_CACHE_SMOKE_FAIL_IF_RUN: '1',
	})
	if (second.code !== 0) {
		throw new Error(
			`Second smoke-probe failed (expected remote hit, command must not run):\n${second.output}\nRequests: ${JSON.stringify(server.requests)}`,
		)
	}
	const restored = await readFile(PROBE_OUTPUT, 'utf8')
	if (restored !== 'remote-cache-probe\n') {
		throw new Error(`Restored probe output was ${JSON.stringify(restored)}`)
	}
	const remoteGets = server.requests.filter(
		(entry) =>
			entry.method === 'GET' &&
			entry.pathname.startsWith('/v1/cache/') &&
			entry.status === 200,
	)
	if (remoteGets.length === 0) {
		throw new Error(
			`Nx did not GET a stored artifact after the local cache wipe.\nRequests: ${JSON.stringify(server.requests)}\n${second.output}`,
		)
	}
	if (!/cache:\s+1\/1 hit/i.test(second.output)) {
		throw new Error(
			`Second run did not report a 1/1 cache hit.\n${second.output}`,
		)
	}

	return {
		serverUrl: server.url,
		requests: server.requests,
		firstOutput: first.output,
		secondOutput: second.output,
	}
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await runNxRemoteCacheSmoke()
	console.log('Nx remote cache smoke passed')
	console.log(`server ${result.serverUrl}`)
	console.log(`requests ${JSON.stringify(result.requests)}`)
	console.log('--- first run (miss + PUT) ---')
	console.log(result.firstOutput.trim())
	console.log('--- second run (GET hit, command skipped) ---')
	console.log(result.secondOutput.trim())
}
