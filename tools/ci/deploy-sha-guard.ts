import { spawnSync } from 'node:child_process'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Production deploy SHA guard for `.github/workflows/deploy.yml`.
 *
 * Validate on `main` pushes runs to completion instead of cancelling (#3380),
 * so a busy `main` finishes Validate on commits that are no longer HEAD by the
 * time Deploy starts. Those commits still deploy when production is strictly
 * behind them; HEAD deploys once its own Validate finishes. Production never
 * moves backwards: a commit that is already live, older than live, unrelated
 * to live, or compared against an unreadable live SHA is skipped. Manual
 * `workflow_dispatch` keeps its HEAD-only contract.
 */

export type ProductionDeployDecision = {
	deploy: boolean
	reason: string
}

const commitShaPattern = /^[0-9a-f]{40}$/

export async function decideProductionDeploy(input: {
	eventName: string
	deploySha: string
	headSha: string
	readLiveSha: () => Promise<string | null>
	isAncestor: (ancestor: string, descendant: string) => boolean
}): Promise<ProductionDeployDecision> {
	const { eventName, deploySha, headSha } = input
	if (deploySha === headSha) {
		return { deploy: true, reason: `${deploySha} is main HEAD.` }
	}
	if (eventName !== 'workflow_run') {
		return {
			deploy: false,
			reason: `target ${deploySha} is not main HEAD ${headSha}; manual dispatch only deploys HEAD.`,
		}
	}
	if (!input.isAncestor(deploySha, headSha)) {
		return {
			deploy: false,
			reason: `target ${deploySha} is not an ancestor of main HEAD ${headSha}.`,
		}
	}
	const liveSha = await input.readLiveSha()
	if (!liveSha) {
		return {
			deploy: false,
			reason: `target ${deploySha} is not main HEAD ${headSha} and the live production commit is unknown.`,
		}
	}
	if (liveSha === deploySha) {
		return {
			deploy: false,
			reason: `target ${deploySha} is already live.`,
		}
	}
	if (!input.isAncestor(liveSha, deploySha)) {
		return {
			deploy: false,
			reason: `target ${deploySha} is not ahead of live production ${liveSha}.`,
		}
	}
	return {
		deploy: true,
		reason: `live production ${liveSha} is behind validated main commit ${deploySha}; main HEAD ${headSha} deploys after its own Validate.`,
	}
}

export function parseLiveCommitSha(body: string): string | null {
	try {
		const json = JSON.parse(body) as { commitSha?: unknown }
		const sha = json?.commitSha
		return typeof sha === 'string' && commitShaPattern.test(sha) ? sha : null
	} catch {
		return null
	}
}

async function readLiveProductionSha(healthUrl: string) {
	try {
		const response = await fetch(healthUrl, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) return null
		return parseLiveCommitSha(await response.text())
	} catch {
		return null
	}
}

function gitHasCommit(sha: string) {
	const result = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
		stdio: 'ignore',
	})
	return result.status === 0
}

function gitIsAncestor(ancestor: string, descendant: string) {
	const result = spawnSync(
		'git',
		['merge-base', '--is-ancestor', ancestor, descendant],
		{ stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
	)
	if (result.status === 0) return true
	if (result.status === 1) return false
	throw new Error(
		`git merge-base --is-ancestor ${ancestor} ${descendant} failed (${result.status ?? result.signal}): ${result.stderr.trim()}`,
	)
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) {
		throw new Error(`Missing ${name} for deploy SHA guard.`)
	}
	return value
}

export async function main() {
	const productionUrl = requireEnv('PRODUCTION_URL')
	const decision = await decideProductionDeploy({
		eventName: requireEnv('EVENT_NAME'),
		deploySha: requireEnv('DEPLOY_SHA'),
		headSha: requireEnv('HEAD_SHA'),
		readLiveSha: async () => {
			const liveSha = await readLiveProductionSha(
				`${productionUrl.replace(/\/$/, '')}/health`,
			)
			// A live build from a commit this clone lacks is as unknown as an
			// unreadable /health.
			return liveSha && gitHasCommit(liveSha) ? liveSha : null
		},
		isAncestor: gitIsAncestor,
	})
	console.error(
		`${decision.deploy ? 'Deploying' : 'Skipping deploy'}: ${decision.reason}`,
	)
	process.stdout.write(`should_deploy=${String(decision.deploy)}\n`)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
