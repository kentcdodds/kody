import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	defaultGithubRepoUrl,
	encodeDeployInfo,
	githubActionsRunUrl,
	githubPullRequestUrl,
	pullRequestNumberFromCommitMessage,
	truncateCommitMessage,
	type DeployInfo,
	type DeployPullRequestInfo,
} from '#worker/deploy-info.ts'

const execFileAsync = promisify(execFile)

export type BuildDeployInfoInput = {
	sha: string
	repoUrl?: string
	environment?: string
	workflow?: string | null
	job?: string | null
	runId?: string | null
	runAttempt?: string | null
	runUrl?: string | null
	pullRequest?: DeployPullRequestInfo | null
	commit?: {
		message: string
		committedAt: string | null
	}
	now?: string
	githubApiUrl?: string
	githubToken?: string
	readCommit?: (sha: string) => Promise<{
		message: string
		committedAt: string | null
	}>
	lookupPullRequests?: (sha: string) => Promise<Array<DeployPullRequestInfo>>
}

export async function buildDeployInfo(
	input: BuildDeployInfoInput,
): Promise<DeployInfo> {
	const repoUrl = trimOr(input.repoUrl, defaultGithubRepoUrl)
	const commit =
		input.commit ?? (await (input.readCommit ?? readGitCommit)(input.sha))
	const message = truncateCommitMessage(commit.message)
	const pullRequest =
		input.pullRequest === undefined
			? await resolvePullRequest({
					sha: input.sha,
					repoUrl,
					message,
					lookupPullRequests: input.lookupPullRequests,
					githubApiUrl: input.githubApiUrl,
					githubToken: input.githubToken,
				})
			: input.pullRequest
	const runId = trimToNull(input.runId)
	const runUrl =
		trimToNull(input.runUrl) ??
		(runId ? githubActionsRunUrl(repoUrl, runId, input.runAttempt) : null)
	return {
		repoUrl,
		commit: {
			sha: input.sha,
			message,
			committedAt: commit.committedAt,
		},
		pullRequest,
		deploy: {
			deployedAt: input.now ?? new Date().toISOString(),
			environment: trimOr(input.environment, 'unknown'),
			workflow: trimToNull(input.workflow),
			job: trimToNull(input.job),
			runId,
			runUrl,
		},
	}
}

export function readDeployInfoInputFromEnv(
	env: NodeJS.ProcessEnv,
): BuildDeployInfoInput {
	const sha = env.DEPLOY_COMMIT_SHA?.trim() || env.APP_COMMIT_SHA?.trim()
	if (!sha) {
		throw new Error(
			'build-deploy-info requires DEPLOY_COMMIT_SHA or APP_COMMIT_SHA',
		)
	}
	const serverUrl = trimOr(env.GITHUB_SERVER_URL, 'https://github.com')
	const repository = env.GITHUB_REPOSITORY?.trim()
	const repoUrl = repository
		? `${trimTrailingSlash(serverUrl)}/${repository}`
		: defaultGithubRepoUrl
	const prNumber = parsePositiveInteger(env.DEPLOY_PR_NUMBER)
	const prUrl =
		env.DEPLOY_PR_URL?.trim() ||
		(prNumber ? githubPullRequestUrl(repoUrl, prNumber) : null)
	const pullRequest = prNumber
		? {
				number: prNumber,
				url: prUrl ?? githubPullRequestUrl(repoUrl, prNumber),
				title: env.DEPLOY_PR_TITLE?.trim() || null,
			}
		: undefined
	return {
		sha,
		repoUrl,
		environment: env.DEPLOY_ENVIRONMENT?.trim() || undefined,
		workflow: env.GITHUB_WORKFLOW,
		job: env.GITHUB_JOB,
		runId: env.GITHUB_RUN_ID,
		runAttempt: env.GITHUB_RUN_ATTEMPT,
		runUrl: env.DEPLOY_RUN_URL,
		pullRequest,
		now: env.DEPLOYED_AT,
		githubApiUrl: env.GITHUB_API_URL,
		githubToken: env.GITHUB_TOKEN ?? env.GH_TOKEN,
	}
}

async function resolvePullRequest(input: {
	sha: string
	repoUrl: string
	message: string
	lookupPullRequests?: BuildDeployInfoInput['lookupPullRequests']
	githubApiUrl?: string
	githubToken?: string
}): Promise<DeployPullRequestInfo | null> {
	const lookedUp = await (
		input.lookupPullRequests ??
		((sha: string) =>
			lookupGithubPullRequests({
				sha,
				repoUrl: input.repoUrl,
				apiUrl: input.githubApiUrl,
				token: input.githubToken,
			}))
	)(input.sha)
	if (lookedUp[0]) return lookedUp[0]
	const number = pullRequestNumberFromCommitMessage(input.message)
	if (!number) return null
	return {
		number,
		url: githubPullRequestUrl(input.repoUrl, number),
		title: null,
	}
}

async function lookupGithubPullRequests(input: {
	sha: string
	repoUrl: string
	apiUrl?: string
	token?: string
}): Promise<Array<DeployPullRequestInfo>> {
	const repository = repositoryFromRepoUrl(input.repoUrl)
	if (!repository || !input.token) return []
	const apiUrl = trimOr(input.apiUrl, 'https://api.github.com')
	try {
		const response = await fetch(
			`${trimTrailingSlash(apiUrl)}/repos/${repository}/commits/${input.sha}/pulls`,
			{
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${input.token}`,
					'X-GitHub-Api-Version': '2022-11-28',
				},
			},
		)
		if (!response.ok) return []
		const payload: unknown = await response.json()
		if (!Array.isArray(payload)) return []
		return payload.flatMap((entry) => {
			if (!isRecord(entry)) return []
			if (typeof entry.number !== 'number') return []
			if (typeof entry.html_url !== 'string') return []
			return [
				{
					number: entry.number,
					url: entry.html_url,
					title: typeof entry.title === 'string' ? entry.title : null,
				},
			]
		})
	} catch {
		return []
	}
}

async function readGitCommit(sha: string) {
	const { stdout } = await execFileAsync('git', [
		'show',
		'-s',
		'--format=%cI%n%B',
		sha,
	])
	const [committedAt, ...messageLines] = stdout.split('\n')
	return {
		committedAt: committedAt?.trim() || null,
		message: messageLines.join('\n').trim(),
	}
}

function repositoryFromRepoUrl(repoUrl: string) {
	try {
		const url = new URL(repoUrl)
		return url.pathname.replace(/^\//, '').replace(/\.git$/, '')
	} catch {
		return null
	}
}

function parsePositiveInteger(value: string | undefined) {
	if (!value?.trim()) return null
	const number = Number(value)
	return Number.isInteger(number) && number > 0 ? number : null
}

function trimOr(value: string | undefined, fallback: string) {
	const trimmed = value?.trim()
	return trimmed ? trimmed : fallback
}

function trimToNull(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed ? trimmed : null
}

function trimTrailingSlash(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

export async function main() {
	const info = await buildDeployInfo(readDeployInfoInputFromEnv(process.env))
	process.stdout.write(encodeDeployInfo(info))
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
