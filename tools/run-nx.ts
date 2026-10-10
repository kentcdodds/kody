import { spawn } from 'node:child_process'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'
import {
	formatNxRemoteCacheProbe,
	type NxRemoteCacheProbe,
	nxRemoteCacheServerEnv,
	nxRemoteCacheTokenEnv,
	probeNxRemoteCache,
} from './nx-remote-cache-probe.ts'

export { nxRemoteCacheServerEnv }

export type NxRunResult = {
	status: number
	output: string
	errorMessage: string
}

export type NxRun = (
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
) => NxRunResult | Promise<NxRunResult>

export function isNxRemoteCacheTransportFailure(output: string) {
	return (
		output.includes('Failed to send request:') && output.includes('/v1/cache/')
	)
}

export function nxTasksSucceededDespiteRemoteCacheFailure(output: string) {
	return (
		isNxRemoteCacheTransportFailure(output) &&
		output.includes('Successfully ran target')
	)
}

/**
 * Stream stdout/stderr to the parent and wait for `close` so the last pipe
 * chunks are captured before cache-failure classification.
 */
export function spawnNx(
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
	forwardTo: {
		stdout?: NodeJS.WritableStream
		stderr?: NodeJS.WritableStream
	} = {},
): Promise<NxRunResult> {
	const stdout = forwardTo.stdout ?? process.stdout
	const stderr = forwardTo.stderr ?? process.stderr
	return new Promise((resolve) => {
		const chunks: Array<string> = []
		const child = spawn(resolveLocalBinary('nx'), [...args], {
			env,
			stdio: ['inherit', 'pipe', 'pipe'],
		})
		function forward(
			stream: NodeJS.ReadableStream | null,
			dest: NodeJS.WritableStream,
		) {
			if (!stream) return
			stream.on('data', (chunk: Buffer | string) => {
				const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
				chunks.push(text)
				dest.write(chunk)
			})
		}
		forward(child.stdout, stdout)
		forward(child.stderr, stderr)
		let settled = false
		function finish(result: NxRunResult) {
			if (settled) return
			settled = true
			resolve(result)
		}
		child.once('error', (error) => {
			finish({
				status: 1,
				output: chunks.join(''),
				errorMessage: error.message,
			})
		})
		child.once('close', (code) => {
			finish({
				status: code ?? 1,
				output: chunks.join(''),
				errorMessage: '',
			})
		})
	})
}

export function nxCacheSummaryLine(output: string) {
	return /Cache:\s+\S+ hit \([^)]*\)/.exec(output)?.[0] ?? 'Cache: n/a'
}

/**
 * Nx says nothing when the server rejects an upload, so after every run that
 * had the remote cache configured, ask the server whether this token writes
 * and print the answer next to Nx's own hit count. Never changes the status.
 */
export async function reportNxRemoteCache(input: {
	output: string
	env: NodeJS.ProcessEnv
	remote: NxRemoteOutcome
	probe?: typeof probeNxRemoteCache
	log: (line: string) => void
}) {
	const server = input.env[nxRemoteCacheServerEnv]
	if (!server) return
	if (input.remote === 'retried-locally') {
		input.log(
			`Nx remote cache skipped (${server}): the run that passed retried without the remote cache after a transport failure, so nothing was uploaded. ${nxCacheSummaryLine(input.output)}`,
		)
		return
	}
	const probe: NxRemoteCacheProbe = await (input.probe ?? probeNxRemoteCache)({
		server,
		token: input.env[nxRemoteCacheTokenEnv] ?? '',
	})
	input.log(
		`${formatNxRemoteCacheProbe(probe)} ${nxCacheSummaryLine(input.output)}`,
	)
}

export async function runNxWithRemoteCacheFallback(input: {
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
	run?: NxRun
	probe?: typeof probeNxRemoteCache
	log?: (line: string) => void
}): Promise<NxRunResult> {
	const env = input.env ?? process.env
	const run = input.run ?? spawnNx
	const log =
		input.log ??
		((line) => {
			console.error(line)
		})

	const { result, remote } = await runNxOnce({ ...input, env, run, log })
	await reportNxRemoteCache({
		output: result.output,
		env,
		remote,
		probe: input.probe,
		log,
	})
	return result
}

/**
 * `used`: the run that produced the result talked to the remote cache (even if
 * a late transport failure was tolerated). `retried-locally`: the result comes
 * from the `--skipRemoteCache` retry, so no probe can speak for its uploads.
 */
export type NxRemoteOutcome = 'used' | 'retried-locally'

async function runNxOnce(input: {
	args: ReadonlyArray<string>
	env: NodeJS.ProcessEnv
	run: NxRun
	log: (line: string) => void
}): Promise<{ result: NxRunResult; remote: NxRemoteOutcome }> {
	const { env, run, log } = input
	const first = await run(input.args, env)
	if (first.status === 0) return { result: first, remote: 'used' }

	const combined = `${first.output} ${first.errorMessage}`
	if (!isNxRemoteCacheTransportFailure(combined)) {
		return { result: first, remote: 'used' }
	}

	if (nxTasksSucceededDespiteRemoteCacheFailure(combined)) {
		log(
			'Nx remote cache request failed after tasks succeeded; treating the run as successful.',
		)
		return { result: { ...first, status: 0 }, remote: 'used' }
	}

	if (!env[nxRemoteCacheServerEnv]) return { result: first, remote: 'used' }

	log(
		'Nx remote cache request failed before tasks finished; retrying without the remote cache.',
	)
	const retryEnv = { ...env }
	delete retryEnv[nxRemoteCacheServerEnv]
	const retried = await run([...input.args, '--skipRemoteCache'], retryEnv)
	return { result: retried, remote: 'retried-locally' }
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await runNxWithRemoteCacheFallback({
		args: process.argv.slice(2),
	})
	process.exit(result.status)
}
