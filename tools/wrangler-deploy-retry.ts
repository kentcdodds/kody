import { spawn } from 'node:child_process'
import { isRetryableCloudflareFailure } from './ci/resource-utils.ts'

export const wranglerDeployRetryMaxAttempts = 4
export const wranglerDeployRetryBaseDelayMs = 1_000

export function isRetryableWorkersDevSubdomainRace(output: string) {
	const uploaded = /uploaded\s+\S+/i.test(output)
	const missingAfterUpload =
		/\b10007\b/.test(output) &&
		/this worker does not exist on your account/i.test(output)
	return uploaded && missingAfterUpload
}

export function isRetryableWranglerDeployFailure(output: string) {
	return (
		isRetryableWorkersDevSubdomainRace(output) ||
		isRetryableCloudflareFailure(output)
	)
}

export type WranglerDeployRunResult = {
	status: number
	output: string
	errorMessage: string
}

export type WranglerDeployRun = (
	command: string,
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
) => WranglerDeployRunResult | Promise<WranglerDeployRunResult>

/**
 * Stream stdout/stderr to the parent (no spawnSync maxBuffer) and wait for
 * `close` so the last pipe chunks are captured before retry classification.
 */
export function spawnWranglerDeploy(
	command: string,
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
	forwardTo: {
		stdout?: NodeJS.WritableStream
		stderr?: NodeJS.WritableStream
	} = {},
): Promise<WranglerDeployRunResult> {
	const stdout = forwardTo.stdout ?? process.stdout
	const stderr = forwardTo.stderr ?? process.stderr
	return new Promise((resolve) => {
		const chunks: Array<string> = []
		const child = spawn(command, [...args], {
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
		function finish(result: WranglerDeployRunResult) {
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

export async function runWranglerDeployWithRetry(input: {
	command: string
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
	maxAttempts?: number
	sleep?: (ms: number) => Promise<void>
	run?: WranglerDeployRun
	log?: (line: string) => void
}) {
	const maxAttempts = input.maxAttempts ?? wranglerDeployRetryMaxAttempts
	const wait =
		input.sleep ??
		((ms: number) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms)
			}))
	const run = input.run ?? spawnWranglerDeploy
	const log =
		input.log ??
		((line) => {
			console.error(line)
		})

	let last = await run(input.command, input.args, input.env)
	for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
		if (last.status === 0) return last
		const combined = `${last.output} ${last.errorMessage}`
		if (!isRetryableWranglerDeployFailure(combined)) return last
		log(
			`Retrying wrangler deploy (attempt ${attempt + 1}/${maxAttempts}) after a transient Cloudflare deploy race.`,
		)
		await wait(wranglerDeployRetryBaseDelayMs * 2 ** (attempt - 1))
		last = await run(input.command, input.args, input.env)
	}
	return last
}
