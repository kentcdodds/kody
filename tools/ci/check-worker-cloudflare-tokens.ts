import { isExecutedDirectly } from '../node-runtime.ts'

export const deployTokenEnvName = 'CLOUDFLARE_API_TOKEN'

/**
 * GitHub Actions secrets whose values are uploaded as a Worker's
 * `CLOUDFLARE_API_TOKEN` secret. The deploy token (`CLOUDFLARE_API_TOKEN` in
 * the Actions shell) authenticates wrangler and `tools/ci` only and must never
 * reach a Worker (#2010).
 */
export const workerTokenPermissions = {
	CLOUDFLARE_APP_API_TOKEN:
		'kody-production + kody-platform: Account Email Sending Edit, Artifacts Edit, Account Analytics Read, Queues Edit',
	CLOUDFLARE_RUNTIME_API_TOKEN:
		'kody-runtime: Account Email Sending Edit, Artifacts Edit',
	CLOUDFLARE_STATUS_API_TOKEN: 'kody-status: Account Email Sending Edit',
} as const

export type WorkerTokenEnvName = keyof typeof workerTokenPermissions

function isWorkerTokenEnvName(name: string): name is WorkerTokenEnvName {
	return Object.hasOwn(workerTokenPermissions, name)
}

export function findWorkerTokenProblems(
	env: Readonly<Record<string, string | undefined>>,
	names: ReadonlyArray<WorkerTokenEnvName>,
): Array<string> {
	const deployToken = env[deployTokenEnvName]?.trim() ?? ''
	const problems: Array<string> = []
	for (const name of names) {
		const value = env[name]?.trim() ?? ''
		const scope = workerTokenPermissions[name]
		if (!value) {
			problems.push(
				`Missing GitHub Actions secret ${name} (${scope}). Worker deploys never fall back to ${deployTokenEnvName}.`,
			)
			continue
		}
		if (deployToken && value === deployToken) {
			problems.push(
				`GitHub Actions secret ${name} matches the deploy token ${deployTokenEnvName}. Mint a separate token scoped to ${scope}.`,
			)
		}
	}
	return problems
}

export function main(
	args = process.argv.slice(2),
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	const unknown = args.filter((name) => !isWorkerTokenEnvName(name))
	if (args.length === 0 || unknown.length > 0) {
		console.error(
			`Usage: node tools/ci/check-worker-cloudflare-tokens.ts <${Object.keys(workerTokenPermissions).join('|')}>...`,
		)
		process.exitCode = 1
		return
	}
	const problems = findWorkerTokenProblems(
		env,
		args.filter(isWorkerTokenEnvName),
	)
	for (const problem of problems) {
		console.error(`::error::${problem}`)
	}
	if (problems.length > 0) {
		process.exitCode = 1
		return
	}
	console.log(`Worker-scoped Cloudflare tokens present: ${args.join(', ')}`)
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
