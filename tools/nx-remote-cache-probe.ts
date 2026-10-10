import { appendFileSync } from 'node:fs'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Nx's self-hosted cache client is silent when `PUT /v1/cache/{hash}` is
 * rejected (a read-only token gets 403 and Nx prints nothing), so a wrong
 * write token looks like "remote cache enabled" with a permanent 0% hit rate.
 * This probe asks the server the three questions Nx never answers out loud:
 * is it reachable, does the token read, and does the token write.
 */

export const nxRemoteCacheServerEnv = 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER'
export const nxRemoteCacheTokenEnv = 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN'
export const defaultNxRemoteCacheServer = 'https://nx-cache.kody.codes'

/** Never a real Nx hash (u64 decimal); matches the server's hash pattern. */
export const readProbeHash = '0000000000000000'
export const writeProbeHash = '00000000000000000000000000000001'
const writeProbeBody = 'kody nx remote cache write probe\n'
const probeTimeoutMs = 5_000

export type NxRemoteCacheProbe = {
	server: string
	health: 'ok' | 'unreachable'
	/** `ok` when an authorized GET answers 200/404; otherwise the HTTP status. */
	read: 'ok' | 'unauthorized' | `http-${number}` | 'error'
	/** `ok` on 200/409, `read-only` on 403; `skipped` when read already failed. */
	write: 'ok' | 'read-only' | `http-${number}` | 'error' | 'skipped'
}

type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Pick<Response, 'status'>>

async function statusOf(
	fetchImpl: FetchLike,
	input: string,
	init?: RequestInit,
): Promise<number | null> {
	try {
		const response = await fetchImpl(input, {
			...init,
			signal: AbortSignal.timeout(probeTimeoutMs),
		})
		return response.status
	} catch {
		return null
	}
}

export async function probeNxRemoteCache(input: {
	server: string
	token: string
	fetch?: FetchLike
}): Promise<NxRemoteCacheProbe> {
	const fetchImpl = input.fetch ?? ((url, init) => fetch(url, init))
	const server = input.server.replace(/\/+$/, '')
	const probe: NxRemoteCacheProbe = {
		server,
		health: 'unreachable',
		read: 'error',
		write: 'skipped',
	}
	const health = await statusOf(fetchImpl, `${server}/health`)
	if (health !== 200) return probe
	probe.health = 'ok'

	const authorization = { Authorization: `Bearer ${input.token}` }
	const read = await statusOf(
		fetchImpl,
		`${server}/v1/cache/${readProbeHash}`,
		{
			headers: authorization,
		},
	)
	if (read === 200 || read === 404) probe.read = 'ok'
	else if (read === 401) probe.read = 'unauthorized'
	else if (read !== null) probe.read = `http-${read}`
	if (probe.read !== 'ok') return probe

	const write = await statusOf(
		fetchImpl,
		`${server}/v1/cache/${writeProbeHash}`,
		{
			method: 'PUT',
			headers: {
				...authorization,
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(Buffer.byteLength(writeProbeBody)),
			},
			body: writeProbeBody,
		},
	)
	if (write === 200 || write === 409) probe.write = 'ok'
	else if (write === 403) probe.write = 'read-only'
	else if (write !== null) probe.write = `http-${write}`
	else probe.write = 'error'
	return probe
}

/** True when Nx can be pointed at the server without failing the run. */
export function nxRemoteCacheUsable(probe: NxRemoteCacheProbe) {
	return probe.health === 'ok' && probe.read === 'ok'
}

export function formatNxRemoteCacheProbe(probe: NxRemoteCacheProbe) {
	if (probe.health !== 'ok') {
		return `Nx remote cache skipped: ${probe.server}/health is unreachable; running with the local cache only.`
	}
	if (probe.read !== 'ok') {
		return `Nx remote cache skipped: ${probe.server} rejected the token on GET (${probe.read}); running with the local cache only.`
	}
	if (probe.write === 'ok') {
		return `Nx remote cache enabled (${probe.server}): token reads and writes.`
	}
	if (probe.write === 'read-only') {
		return `Nx remote cache enabled (${probe.server}) READ-ONLY: PUT returned 403, so nothing this run computes will be uploaded (token is the read token or the worker's write secret differs).`
	}
	return `Nx remote cache enabled (${probe.server}) but the write probe failed (${probe.write}); uploads from this run may be lost.`
}

function parseArgs(argv: ReadonlyArray<string>) {
	let server = process.env[nxRemoteCacheServerEnv] || defaultNxRemoteCacheServer
	let githubEnv = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--server') {
			server = argv[index + 1] ?? server
			index += 1
		} else if (arg === '--github-env') {
			githubEnv = true
		}
	}
	return { server, githubEnv }
}

if (isExecutedDirectly(import.meta.url)) {
	const { server, githubEnv } = parseArgs(process.argv.slice(2))
	const token = process.env[nxRemoteCacheTokenEnv] ?? ''
	if (!token) {
		console.log(
			`Nx remote cache skipped: ${nxRemoteCacheTokenEnv} is not set; running with the local cache only.`,
		)
		process.exit(0)
	}
	const probe = await probeNxRemoteCache({ server, token })
	console.log(formatNxRemoteCacheProbe(probe))
	if (nxRemoteCacheUsable(probe)) {
		if (probe.write !== 'ok') {
			console.log(
				`::warning title=Nx remote cache is not writable::${formatNxRemoteCacheProbe(probe)}`,
			)
		}
		if (githubEnv && process.env.GITHUB_ENV) {
			appendFileSync(
				process.env.GITHUB_ENV,
				`${nxRemoteCacheServerEnv}=${probe.server}\n`,
			)
		}
	}
	process.exit(0)
}
