import { spawnSync } from 'node:child_process'
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

export async function runWranglerDeployWithRetry(input: {
	command: string
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
	maxAttempts?: number
	sleep?: (ms: number) => Promise<void>
	run?: (
		command: string,
		args: ReadonlyArray<string>,
		env?: NodeJS.ProcessEnv,
	) => WranglerDeployRunResult
	log?: (line: string) => void
}) {
	const maxAttempts = input.maxAttempts ?? wranglerDeployRetryMaxAttempts
	const wait =
		input.sleep ??
		((ms: number) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms)
			}))
	const run =
		input.run ??
		((command, args, env) => {
			const result = spawnSync(command, [...args], {
				encoding: 'utf8',
				env,
			})
			return {
				status: result.status ?? 1,
				output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
				errorMessage: result.error?.message ?? '',
			}
		})
	const log =
		input.log ??
		((line) => {
			console.error(line)
		})

	const echoOutput = input.run === undefined
	let last = run(input.command, input.args, input.env)
	if (echoOutput && last.output) process.stdout.write(last.output)
	for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
		if (last.status === 0) return last
		const combined = `${last.output} ${last.errorMessage}`
		if (!isRetryableWranglerDeployFailure(combined)) return last
		log(
			`Retrying wrangler deploy (attempt ${attempt + 1}/${maxAttempts}) after a transient Cloudflare deploy race.`,
		)
		await wait(wranglerDeployRetryBaseDelayMs * 2 ** (attempt - 1))
		last = run(input.command, input.args, input.env)
		if (echoOutput && last.output) process.stdout.write(last.output)
	}
	return last
}
