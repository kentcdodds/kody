import { spawn } from 'node:child_process'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'

export const nxRemoteCacheServerEnv = 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER'

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

export async function runNxWithRemoteCacheFallback(input: {
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
	run?: NxRun
	log?: (line: string) => void
}): Promise<NxRunResult> {
	const env = input.env ?? process.env
	const run = input.run ?? spawnNx
	const log =
		input.log ??
		((line) => {
			console.error(line)
		})

	const first = await run(input.args, env)
	if (first.status === 0) return first

	const combined = `${first.output} ${first.errorMessage}`
	if (!isNxRemoteCacheTransportFailure(combined)) return first

	if (nxTasksSucceededDespiteRemoteCacheFailure(combined)) {
		log(
			'Nx remote cache request failed after tasks succeeded; treating the run as successful.',
		)
		return { ...first, status: 0 }
	}

	if (!env[nxRemoteCacheServerEnv]) return first

	log(
		'Nx remote cache request failed before tasks finished; retrying without the remote cache.',
	)
	const retryEnv = { ...env }
	delete retryEnv[nxRemoteCacheServerEnv]
	return run([...input.args, '--skipRemoteCache'], retryEnv)
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await runNxWithRemoteCacheFallback({
		args: process.argv.slice(2),
	})
	process.exit(result.status)
}
