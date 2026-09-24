import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * GitHub does not start `pull_request` workflows when a pull request is
 * `dirty`: it cannot build the merge commit, so Validate, Preview, and CLA
 * never report a check. This command runs from the default-branch
 * `pull_request_target` workflow, which still starts, and writes a check onto
 * the head SHA. A push to the base branch reruns that check for every open
 * pull request, because the head commit does not move when the base does.
 * Retargeting the base does the same. It does not check out or execute pull
 * request code, and it does not run Validate.
 */
export const mergeConflictCheckName = '🚧 Merge conflicts'

export const mergeConflictPollAttempts = 20
export const mergeConflictPollDelayMs = 3_000
const openPullRequestPageSize = 100
const openPullRequestMaxPages = 20
const openPullRequestScanConcurrency = 4

const githubApiVersion = '2022-11-28'
const safeBaseRefPattern = /^[A-Za-z0-9._/-]+$/

export type MergeabilityKind = 'pending' | 'conflicted' | 'clear'

export type PullRequestMergeability = {
	mergeable: boolean | null
	mergeableState: string
	baseRef: string
	draft: boolean
}

export type ResolvedMergeability = {
	kind: 'conflicted' | 'clear' | 'undetermined'
	baseRef: string
	mergeableState: string
	draft: boolean
	detail?: string
}

type MergeConflictCheckOutput = {
	title: string
	summary: string
	conclusion: 'success' | 'failure'
}

type FetchLike = typeof fetch

export function classifyMergeability(input: {
	mergeable: boolean | null
	mergeableState: string
}): MergeabilityKind {
	const state = input.mergeableState.trim().toLowerCase()
	// `dirty` is the only state where GitHub skips pull_request workflows.
	// `behind`, `blocked`, `unstable`, `draft`, `clean`, and `has_hooks` still
	// build a merge commit, so those workflows still run.
	if (state === 'dirty') return 'conflicted'
	if (input.mergeable === null || state === 'unknown' || state === '') {
		return 'pending'
	}
	return 'clear'
}

export function describeMergeConflictCheck(
	input: ResolvedMergeability,
): MergeConflictCheckOutput {
	const base = displayBaseRef(input.baseRef)
	const state = input.mergeableState.trim().toLowerCase() || 'unknown'
	switch (input.kind) {
		case 'conflicted':
			return {
				title: `Conflicts with ${base}`,
				summary: conflictedSummary({ base, state, draft: input.draft }),
				conclusion: 'failure',
			}
		case 'clear':
			return {
				title: `No conflicts with ${base}`,
				summary: clearSummary({ base, state, draft: input.draft }),
				conclusion: 'success',
			}
		case 'undetermined':
			return {
				title: 'Mergeability unavailable',
				summary: undeterminedSummary({
					base,
					state,
					detail: input.detail,
				}),
				conclusion: 'failure',
			}
		default: {
			const neverKind: never = input.kind
			throw new Error(`Unhandled mergeability ${String(neverKind)}`)
		}
	}
}

export async function pollMergeability(input: {
	read: () => Promise<PullRequestMergeability>
	sleep: (ms: number) => Promise<void>
	maxAttempts: number
	delayMs: number
}): Promise<ResolvedMergeability> {
	let latest: PullRequestMergeability | null = null
	for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
		latest = await input.read()
		const kind = classifyMergeability(latest)
		if (kind !== 'pending') {
			return {
				kind,
				baseRef: latest.baseRef,
				mergeableState: latest.mergeableState,
				draft: latest.draft,
			}
		}
		if (attempt < input.maxAttempts) await input.sleep(input.delayMs)
	}
	return {
		kind: 'undetermined',
		baseRef: latest?.baseRef ?? '',
		mergeableState: latest?.mergeableState ?? 'unknown',
		draft: latest?.draft ?? false,
	}
}

export async function reportMergeConflictCheck(input: {
	token: string
	repository: string
	pullNumber: number
	headSha: string
	detailsUrl?: string
	fetchImpl?: FetchLike
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	delayMs?: number
}): Promise<number> {
	const fetchImpl = input.fetchImpl ?? fetch
	const { owner, repo } = parseRepository(input.repository)
	const client = createGithubClient({
		token: input.token,
		owner,
		repo,
		fetchImpl,
		detailsUrl: input.detailsUrl,
	})
	let checkRunId: number | null = null
	try {
		checkRunId = await client.openCheck(input.headSha)
		const result = await pollMergeability({
			read: () => client.readPullRequest(input.pullNumber),
			sleep: input.sleep ?? delay,
			maxAttempts: input.maxAttempts ?? mergeConflictPollAttempts,
			delayMs: input.delayMs ?? mergeConflictPollDelayMs,
		})
		await client.completeCheck(checkRunId, result)
		// This job is recorded on the default-branch SHA. Exit 0 after the
		// head check is published so a conflict does not fail that commit.
		// `gh pr checks` reads the head SHA check.
		const described = describeMergeConflictCheck(result)
		console.log(
			result.kind === 'clear'
				? `Check ${mergeConflictCheckName} passed.`
				: `Check ${mergeConflictCheckName} failed.`,
		)
		console.log(described.summary)
		return 0
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		if (checkRunId !== null) {
			const published = await completeCheckAfterError(
				client,
				checkRunId,
				message,
			)
			if (published) {
				console.log(`Check ${mergeConflictCheckName} failed.`)
				return 0
			}
		}
		return 1
	}
}

export async function reportOpenPullRequestMergeConflicts(input: {
	token: string
	repository: string
	baseRef: string
	detailsUrl?: string
	fetchImpl?: FetchLike
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	delayMs?: number
	concurrency?: number
}): Promise<number> {
	const fetchImpl = input.fetchImpl ?? fetch
	const { owner, repo } = parseRepository(input.repository)
	const client = createGithubClient({
		token: input.token,
		owner,
		repo,
		fetchImpl,
		detailsUrl: input.detailsUrl,
	})
	const pulls = await client.listOpenPullRequests(input.baseRef)
	const codes: Array<number> = []
	await mapPool(
		pulls,
		input.concurrency ?? openPullRequestScanConcurrency,
		async (pullRequest) => {
			codes.push(
				await reportMergeConflictCheck({
					token: input.token,
					repository: input.repository,
					pullNumber: pullRequest.number,
					headSha: pullRequest.headSha,
					detailsUrl: input.detailsUrl,
					fetchImpl,
					sleep: input.sleep,
					maxAttempts: input.maxAttempts,
					delayMs: input.delayMs,
				}),
			)
		},
	)
	return codes.some((code) => code !== 0) ? 1 : 0
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
	try {
		const token = requiredEnv(env, 'GITHUB_TOKEN')
		const repository = requiredEnv(env, 'GITHUB_REPOSITORY')
		const mode = env.MERGE_CONFLICT_MODE
		if (mode === 'open-pulls') {
			process.exitCode = await reportOpenPullRequestMergeConflicts({
				token,
				repository,
				baseRef: requiredEnv(env, 'BASE_REF'),
				detailsUrl: workflowRunUrl(env),
			})
			return
		}
		if (mode !== undefined && mode !== 'pull-request') {
			throw new Error(`Unknown MERGE_CONFLICT_MODE ${mode}`)
		}
		const pullNumber = parsePullNumber(requiredEnv(env, 'PR_NUMBER'))
		const headSha = parseHeadSha(requiredEnv(env, 'HEAD_SHA'))
		process.exitCode = await reportMergeConflictCheck({
			token,
			repository,
			pullNumber,
			headSha,
			detailsUrl: workflowRunUrl(env),
		})
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	}
}

function displayBaseRef(baseRef: string) {
	return safeBaseRefPattern.test(baseRef) ? baseRef : 'its base branch'
}

function conflictedSummary(input: {
	base: string
	state: string
	draft: boolean
}) {
	const ready = input.draft
		? ' Validate, Preview, and CLA also stay skipped until the pull request is marked ready for review.'
		: ''
	return [
		`This pull request conflicts with ${input.base} (mergeable_state: ${input.state}).`,
		'GitHub does not start Validate, Preview, or CLA while it cannot build the merge commit, so those checks never appear for this commit.',
		`Merge ${input.base} into this branch and push. Those workflows run on the next update once the branch is mergeable.${ready}`,
	].join('\n\n')
}

function clearSummary(input: { base: string; state: string; draft: boolean }) {
	if (input.draft) {
		return [
			`This draft has no merge conflicts with ${input.base} (mergeable_state: ${input.state}).`,
			'Validate, Preview, and CLA stay skipped until the pull request is marked ready for review.',
		].join('\n\n')
	}
	return [
		`This pull request has no merge conflicts with ${input.base} (mergeable_state: ${input.state}).`,
		'Validate, Preview, and CLA run from their pull_request workflows.',
	].join('\n\n')
}

function undeterminedSummary(input: {
	base: string
	state: string
	detail?: string
}) {
	const lines = [
		`GitHub has not published mergeability for this pull request yet (mergeable_state: ${input.state}).`,
		`Re-run the ${mergeConflictCheckName} check. Validate, Preview, and CLA run only after GitHub can build the merge commit with ${input.base}.`,
	]
	if (input.detail) lines.push(input.detail.slice(0, 500))
	return lines.join('\n\n')
}

function parseRepository(repository: string) {
	const parts = repository.split('/')
	const owner = parts[0]
	const repo = parts[1]
	if (!owner || !repo || parts.length !== 2) {
		throw new Error(`Expected owner/repo, received ${repository}`)
	}
	return { owner, repo }
}

function parsePullNumber(value: string) {
	if (!/^\d+$/.test(value)) {
		throw new Error(`Expected a pull request number, received ${value}`)
	}
	return Number(value)
}

function parseHeadSha(value: string) {
	if (!/^[0-9a-f]{40}$/i.test(value)) {
		throw new Error('Expected HEAD_SHA to be a 40-character commit SHA')
	}
	return value
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
	const value = env[name]
	if (!value) throw new Error(`Missing ${name}`)
	return value
}

function workflowRunUrl(env: NodeJS.ProcessEnv) {
	const server = env.GITHUB_SERVER_URL
	const repository = env.GITHUB_REPOSITORY
	const runId = env.GITHUB_RUN_ID
	if (!server || !repository || !runId || !/^\d+$/.test(runId)) return undefined
	if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(server)) return undefined
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined
	return `${server}/${repository}/actions/runs/${runId}`
}

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

type ListedPullRequest = {
	number: number
	headSha: string
}

type GithubClient = {
	openCheck: (headSha: string) => Promise<number>
	readPullRequest: (pullNumber: number) => Promise<PullRequestMergeability>
	listOpenPullRequests: (baseRef: string) => Promise<Array<ListedPullRequest>>
	completeCheck: (
		checkRunId: number,
		result: ResolvedMergeability,
	) => Promise<void>
}

function createGithubClient(input: {
	token: string
	owner: string
	repo: string
	fetchImpl: FetchLike
	detailsUrl?: string
}): GithubClient {
	const repoPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`

	async function github(method: string, path: string, body?: unknown) {
		const response = await input.fetchImpl(`https://api.github.com${path}`, {
			method,
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${input.token}`,
				'Content-Type': 'application/json',
				'User-Agent': 'kody-merge-conflict-check',
				'X-GitHub-Api-Version': githubApiVersion,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await response.text()
		if (!response.ok) {
			throw new Error(
				`GitHub API ${method} ${path} failed (${String(response.status)}): ${text.slice(0, 500)}`,
			)
		}
		if (!text) return null
		try {
			return JSON.parse(text) as unknown
		} catch {
			throw new Error(`GitHub API ${method} ${path} returned non-JSON`)
		}
	}

	return {
		async openCheck(headSha) {
			const payload = await github('POST', `${repoPath}/check-runs`, {
				name: mergeConflictCheckName,
				head_sha: headSha,
				status: 'in_progress',
				started_at: new Date().toISOString(),
				details_url: input.detailsUrl,
				output: {
					title: 'Checking mergeability',
					summary: [
						'Checking whether this pull request conflicts with its base branch.',
						'GitHub skips Validate, Preview, and CLA when the merge commit cannot be built. This check fails in that case so the pull request is not treated as green.',
					].join('\n\n'),
				},
			})
			return readCheckRunId(payload)
		},
		async readPullRequest(pullNumber) {
			const payload = await github(
				'GET',
				`${repoPath}/pulls/${String(pullNumber)}`,
			)
			return parsePullRequest(payload)
		},
		async listOpenPullRequests(baseRef) {
			const pulls: Array<ListedPullRequest> = []
			for (let page = 1; page <= openPullRequestMaxPages; page += 1) {
				const payload = await github(
					'GET',
					`${repoPath}/pulls?state=open&base=${encodeURIComponent(baseRef)}&per_page=${String(openPullRequestPageSize)}&page=${String(page)}`,
				)
				const pagePulls = parseOpenPullRequestPage(payload)
				pulls.push(...pagePulls)
				if (pagePulls.length < openPullRequestPageSize) return pulls
			}
			throw new Error(
				`More than ${String(openPullRequestMaxPages * openPullRequestPageSize)} open pull requests target ${baseRef}`,
			)
		},
		async completeCheck(checkRunId, result) {
			const output = describeMergeConflictCheck(result)
			await github('PATCH', `${repoPath}/check-runs/${String(checkRunId)}`, {
				status: 'completed',
				conclusion: output.conclusion,
				completed_at: new Date().toISOString(),
				details_url: input.detailsUrl,
				output: {
					title: output.title,
					summary: output.summary,
				},
			})
		},
	}
}

async function completeCheckAfterError(
	client: GithubClient,
	checkRunId: number,
	message: string,
) {
	try {
		await client.completeCheck(checkRunId, {
			kind: 'undetermined',
			baseRef: '',
			mergeableState: 'unknown',
			draft: false,
			detail: message,
		})
		return true
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		return false
	}
}

function readCheckRunId(payload: unknown) {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('id' in payload) ||
		typeof payload.id !== 'number'
	) {
		throw new Error('GitHub check run response did not include an id')
	}
	return payload.id
}

async function mapPool<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	run: (item: T) => Promise<void>,
) {
	if (concurrency < 1) {
		throw new Error('concurrency must be at least 1')
	}
	let next = 0
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (next < items.length) {
				const index = next
				next += 1
				const item = items[index]
				if (item === undefined) return
				await run(item)
			}
		},
	)
	await Promise.all(workers)
}

function parseOpenPullRequestPage(payload: unknown): Array<ListedPullRequest> {
	if (!Array.isArray(payload)) {
		throw new Error('Open pull request list was not an array')
	}
	return payload.map((entry) => {
		if (typeof entry !== 'object' || entry === null) {
			throw new Error('Open pull request entry was not an object')
		}
		const record = entry as { number?: unknown; head?: { sha?: unknown } }
		if (typeof record.number !== 'number') {
			throw new Error('Open pull request entry is missing a number')
		}
		const headSha = record.head?.sha
		if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) {
			throw new Error(
				`Open pull request ${String(record.number)} is missing a head SHA`,
			)
		}
		return { number: record.number, headSha }
	})
}

function parsePullRequest(payload: unknown): PullRequestMergeability {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('Pull request response was not an object')
	}
	const record = payload as {
		mergeable?: unknown
		mergeable_state?: unknown
		draft?: unknown
		base?: { ref?: unknown }
	}
	const mergeable =
		record.mergeable === null || typeof record.mergeable === 'boolean'
			? record.mergeable
			: null
	const mergeableState =
		typeof record.mergeable_state === 'string' ? record.mergeable_state : ''
	const baseRef = typeof record.base?.ref === 'string' ? record.base.ref : ''
	return {
		mergeable,
		mergeableState,
		baseRef,
		draft: record.draft === true,
	}
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
}
