const jobExecWorkerCompatibilityDate = '2026-03-24'
const jobExecWorkerCompatibilityFlags = [
	'nodejs_compat',
	'global_fetch_strictly_public',
]

type JobExecInput = {
	loader: WorkerLoader
	jobExecBridge: Fetcher
	code: string
	params?: Record<string, unknown>
}

function createJobExecModuleSource(code: string) {
	return `
import { WorkerEntrypoint } from 'cloudflare:workers'

export class JobExec extends WorkerEntrypoint {
	async run(params) {
		const job = this.env.JOB
		const paramsValue = params ?? {}
${indentCode(code, '\t\t')}
	}
}
`.trim()
}

function indentCode(code: string, indent: string) {
	return code
		.split('\n')
		.map((line) => `${indent}${line}`)
		.join('\n')
}

export async function runJobExecWorker(input: JobExecInput) {
	const worker = input.loader.load({
		compatibilityDate: jobExecWorkerCompatibilityDate,
		compatibilityFlags: jobExecWorkerCompatibilityFlags,
		mainModule: 'job-exec.js',
		modules: {
			'job-exec.js': createJobExecModuleSource(input.code),
		},
		env: {
			JOB: input.jobExecBridge,
		},
		globalOutbound: null,
	})
	const entrypoint = worker.getEntrypoint('JobExec') as unknown as {
		run: (params?: Record<string, unknown>) => Promise<unknown>
	}
	return await entrypoint.run(input.params)
}
