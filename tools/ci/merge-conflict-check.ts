import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * GitHub does not start `pull_request` workflows when a pull request is
 * `dirty`: it cannot build the merge commit, so Validate, Preview, and CLA
 * never report a check. This command runs from the default-branch
 * `pull_request_target` workflow, which still starts, and writes a check onto
 * the head SHA. A push to the base branch reruns that check for every open
 * pull request, because the head commit does not move when the base does.
 * Retargeting the base does the same. A published mergeable_state is not
 * accepted while the pull request's base SHA is still the previous tip, so
 * a cached result can be replaced by a later calculation. GitHub often
 * keeps `base.sha` at the merge-base for a behind pull request and never
 * stores the new tip; after the poll a published non-pending state is used
 * instead of failing closed. A head with no commits ahead of the expected
 * base is skipped (the current tip, or an ancestor of it): writing that
 * check would land on a default-branch SHA. Bots often open a pull request
 * before the first unique commit, and main can move on before they push.
 * A compare miss (fork head, flake) still writes the check so a unique
 * pull request is not skipped. When mergeability stays pending after the
 * poll (including a stale base SHA GitHub never advances), the head check
 * completes as `neutral` rather than failure so behind PRs do not go red
 * until GitHub publishes a real mergeable_state. Conflicted stays failure.
 * A GitHub API rate limit during a default-branch run does not fail this
 * job: the run is recorded on that SHA, and a red job would mark main
 * failed. The head check is written only after mergeability is known, so a
 * quota miss cannot leave an in-progress check on the pull request.
 * Rate-limit waits share one budget for the scan so retries cannot exceed
 * the job timeout. The next pull request update or base push reruns the
 * check. It does not check out or execute pull request code, and it does
 * not run Validate.
 */
export const mergeConflictCheckName = '🚧 Merge conflicts'

export const mergeConflictPollAttempts = 20
export const mergeConflictPollDelayMs = 3_000
const openPullRequestPageSize = 100
const openPullRequestMaxPages = 20
const openPullRequestScanConcurrency = 4
export const githubRateLimitMaxRetries = 2
export const githubRateLimitMaxWaitMs = 90_000
export const githubRateLimitWaitBudgetMs = 90_000
const githubRateLimitDefaultWaitMs = 10_000

const githubApiVersion = '2022-11-28'
const safeBaseRefPattern = /^[A-Za-z0-9._/-]+$/

export type MergeabilityKind = 'pending' | 'conflicted' | 'clear'

export type PullRequestMergeability = {
	mergeable: boolean | null
	mergeableState: string
	baseRef: string
	baseSha: string
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
	conclusion: 'success' | 'failure' | 'neutral'
}

type FetchLike = typeof fetch

export function isGithubRateLimitError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return isGithubRateLimitMessage(message)
}

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
				// Pending / stale-base results are not conflicts. A red head
				// check on every behind PR after a main push blocks ship-pr
				// until someone can re-run the check.
				conclusion: 'neutral',
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
	expectedBaseSha: string
}): Promise<ResolvedMergeability> {
	let latest: PullRequestMergeability | null = null
	for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
		latest = await input.read()
		const kind = classifyMergeability(latest)
		// GitHub can keep the previous mergeable_state after the base moves.
		// Prefer a result whose base.sha is this run's tip; fall through if
		// GitHub never stores that SHA (common for behind pull requests).
		if (kind !== 'pending' && sameSha(latest.baseSha, input.expectedBaseSha)) {
			return {
				kind,
				baseRef: latest.baseRef,
				mergeableState: latest.mergeableState,
				draft: latest.draft,
			}
		}
		if (attempt < input.maxAttempts) await input.sleep(input.delayMs)
	}
	if (latest !== null) {
		const kind = classifyMergeability(latest)
		if (kind !== 'pending') {
			return {
				kind,
				baseRef: latest.baseRef,
				mergeableState: latest.mergeableState,
				draft: latest.draft,
			}
		}
	}
	const staleBase =
		latest !== null && !sameSha(latest.baseSha, input.expectedBaseSha)
	return {
		kind: 'undetermined',
		baseRef: latest?.baseRef ?? '',
		mergeableState: latest?.mergeableState ?? 'unknown',
		draft: latest?.draft ?? false,
		detail: staleBase
			? `Pull request base ${latest?.baseSha || 'is missing'}, not ${input.expectedBaseSha}.`
			: undefined,
	}
}

export async function reportMergeConflictCheck(input: {
	token: string
	repository: string
	pullNumber: number
	headSha: string
	expectedBaseSha: string
	detailsUrl?: string
	fetchImpl?: FetchLike
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	delayMs?: number
}): Promise<number> {
	const sleep = input.sleep ?? delay
	const { owner, repo } = parseRepository(input.repository)
	return await runMergeConflictCheck(
		input,
		createGithubClient({
			token: input.token,
			owner,
			repo,
			fetchImpl: input.fetchImpl ?? fetch,
			detailsUrl: input.detailsUrl,
			sleep,
		}),
		sleep,
	)
}

async function runMergeConflictCheck(
	input: {
		pullNumber: number
		headSha: string
		expectedBaseSha: string
		maxAttempts?: number
		delayMs?: number
	},
	client: GithubClient,
	sleep: (ms: number) => Promise<void>,
): Promise<number> {
	if (sameSha(input.headSha, input.expectedBaseSha)) {
		console.log(
			`Skipping ${mergeConflictCheckName}: pull request head is the default-branch tip.`,
		)
		return 0
	}
	let knownResult: ResolvedMergeability | null = null
	try {
		if (
			await headHasNoUniqueCommits(client, input.expectedBaseSha, input.headSha)
		) {
			return 0
		}
		knownResult = await pollMergeability({
			read: () => client.readPullRequest(input.pullNumber),
			sleep,
			maxAttempts: input.maxAttempts ?? mergeConflictPollAttempts,
			delayMs: input.delayMs ?? mergeConflictPollDelayMs,
			expectedBaseSha: input.expectedBaseSha,
		})
		await client.publishCheck(input.headSha, knownResult)
		// This job is recorded on the default-branch SHA. Exit 0 after the
		// head check is published so a conflict does not fail that commit.
		// `gh pr checks` reads the head SHA check.
		const described = describeMergeConflictCheck(knownResult)
		console.log(mergeConflictCheckLogLine(knownResult.kind))
		console.log(described.summary)
		return 0
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		if (isGithubRateLimitError(error)) {
			console.log(
				`Deferred ${mergeConflictCheckName}: GitHub API rate limited.`,
			)
			return 0
		}
		// Never downgrade a known conflicted/clear result to undetermined
		// (neutral). Retry the known result once; if publication still fails,
		// exit non-zero without posting a masking neutral check.
		if (knownResult) {
			try {
				await client.publishCheck(input.headSha, knownResult)
				const described = describeMergeConflictCheck(knownResult)
				console.log(mergeConflictCheckLogLine(knownResult.kind))
				console.log(described.summary)
				return 0
			} catch (retryError) {
				console.error(
					retryError instanceof Error ? retryError.message : String(retryError),
				)
				return 1
			}
		}
		const published = await publishCheckAfterError(
			client,
			input.headSha,
			message,
		)
		if (published) {
			console.log(
				`Check ${mergeConflictCheckName} deferred (mergeability unavailable).`,
			)
			return 0
		}
		return 1
	}
}

export async function reportOpenPullRequestMergeConflicts(input: {
	token: string
	repository: string
	baseRef: string
	expectedBaseSha: string
	detailsUrl?: string
	fetchImpl?: FetchLike
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	delayMs?: number
	concurrency?: number
}): Promise<number> {
	const fetchImpl = input.fetchImpl ?? fetch
	const sleep = input.sleep ?? delay
	const { owner, repo } = parseRepository(input.repository)
	const client = createGithubClient({
		token: input.token,
		owner,
		repo,
		fetchImpl,
		detailsUrl: input.detailsUrl,
		sleep,
	})
	let pulls: Array<ListedPullRequest>
	try {
		pulls = await client.listOpenPullRequests(input.baseRef)
	} catch (error) {
		if (isGithubRateLimitError(error)) {
			console.error(error instanceof Error ? error.message : String(error))
			console.log(
				`Deferred ${mergeConflictCheckName}: GitHub API rate limited.`,
			)
			return 0
		}
		throw error
	}
	const codes: Array<number> = []
	await mapPool(
		pulls,
		input.concurrency ?? openPullRequestScanConcurrency,
		async (pullRequest) => {
			codes.push(
				await runMergeConflictCheck(
					{
						pullNumber: pullRequest.number,
						headSha: pullRequest.headSha,
						expectedBaseSha: input.expectedBaseSha,
						maxAttempts: input.maxAttempts,
						delayMs: input.delayMs,
					},
					client,
					sleep,
				),
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
				expectedBaseSha: parseCommitSha(
					requiredEnv(env, 'BASE_SHA'),
					'BASE_SHA',
				),
				detailsUrl: workflowRunUrl(env),
			})
			return
		}
		if (mode !== undefined && mode !== 'pull-request') {
			throw new Error(`Unknown MERGE_CONFLICT_MODE ${mode}`)
		}
		const pullNumber = parsePullNumber(requiredEnv(env, 'PR_NUMBER'))
		const headSha = parseCommitSha(requiredEnv(env, 'HEAD_SHA'), 'HEAD_SHA')
		process.exitCode = await reportMergeConflictCheck({
			token,
			repository,
			pullNumber,
			headSha,
			expectedBaseSha: parseCommitSha(requiredEnv(env, 'BASE_SHA'), 'BASE_SHA'),
			detailsUrl: workflowRunUrl(env),
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		process.exitCode = isGithubRateLimitError(error) ? 0 : 1
	}
}

function mergeConflictCheckLogLine(kind: ResolvedMergeability['kind']): string {
	switch (kind) {
		case 'clear':
			return `Check ${mergeConflictCheckName} passed.`
		case 'conflicted':
			return `Check ${mergeConflictCheckName} failed.`
		case 'undetermined':
			return `Check ${mergeConflictCheckName} deferred (mergeability unavailable).`
		default: {
			const neverKind: never = kind
			throw new Error(`Unhandled mergeability ${String(neverKind)}`)
		}
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
		`This check is neutral until GitHub publishes mergeability against ${input.base}; the next pull request update or base-branch push refreshes it. Validate, Preview, and CLA run only after GitHub can build the merge commit.`,
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

function parseCommitSha(value: string, name: string) {
	if (!/^[0-9a-f]{40}$/i.test(value)) {
		throw new Error(`Expected ${name} to be a 40-character commit SHA`)
	}
	return value
}

function sameSha(left: string, right: string) {
	return left.toLowerCase() === right.toLowerCase()
}

async function headHasNoUniqueCommits(
	client: GithubClient,
	expectedBaseSha: string,
	headSha: string,
) {
	try {
		const aheadBy = await client.compareAheadBy(expectedBaseSha, headSha)
		if (aheadBy === 0) {
			console.log(
				`Skipping ${mergeConflictCheckName}: pull request head has no commits ahead of the base.`,
			)
			return true
		}
	} catch (error) {
		if (isGithubRateLimitError(error)) throw error
		const message = error instanceof Error ? error.message : String(error)
		console.log(
			`Continuing ${mergeConflictCheckName}: could not compare head to base (${message}).`,
		)
	}
	return false
}

function parseAheadBy(payload: unknown) {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('Compare response was not an object')
	}
	const aheadBy = (payload as { ahead_by?: unknown }).ahead_by
	if (typeof aheadBy !== 'number' || !Number.isFinite(aheadBy) || aheadBy < 0) {
		throw new Error('Compare response is missing ahead_by')
	}
	return aheadBy
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
	compareAheadBy: (baseSha: string, headSha: string) => Promise<number>
	readPullRequest: (pullNumber: number) => Promise<PullRequestMergeability>
	listOpenPullRequests: (baseRef: string) => Promise<Array<ListedPullRequest>>
	publishCheck: (headSha: string, result: ResolvedMergeability) => Promise<void>
}

function createGithubClient(input: {
	token: string
	owner: string
	repo: string
	fetchImpl: FetchLike
	detailsUrl?: string
	sleep?: (ms: number) => Promise<void>
}): GithubClient {
	const repoPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
	const sleep = input.sleep ?? delay
	let pausedUntil = 0
	let rateLimitWaitedMs = 0

	async function github(method: string, path: string, body?: unknown) {
		for (let attempt = 1; ; attempt += 1) {
			const pauseMs = pausedUntil - Date.now()
			if (pauseMs > 0) {
				await sleep(pauseMs)
				pausedUntil = Date.now()
			}
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
			if (
				isGithubRateLimitResponse(response.status, text) &&
				attempt <= githubRateLimitMaxRetries
			) {
				const waitMs = githubRateLimitWaitMs(response)
				const remainingBudget = githubRateLimitWaitBudgetMs - rateLimitWaitedMs
				if (
					waitMs <= githubRateLimitMaxWaitMs &&
					waitMs > 0 &&
					waitMs <= remainingBudget
				) {
					console.log(
						`GitHub API ${method} ${path} rate limited; retrying in ${String(waitMs)}ms.`,
					)
					rateLimitWaitedMs += waitMs
					pausedUntil = Math.max(pausedUntil, Date.now() + waitMs)
					continue
				}
			}
			if (!response.ok) {
				throw new Error(
					githubApiErrorMessage(method, path, response.status, text),
				)
			}
			if (!text) return null
			try {
				return JSON.parse(text) as unknown
			} catch {
				throw new Error(`GitHub API ${method} ${path} returned non-JSON`)
			}
		}
	}

	return {
		async compareAheadBy(baseSha, headSha) {
			const payload = await github(
				'GET',
				`${repoPath}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
			)
			return parseAheadBy(payload)
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
		async publishCheck(headSha, result) {
			const output = describeMergeConflictCheck(result)
			const completedAt = new Date().toISOString()
			await github('POST', `${repoPath}/check-runs`, {
				name: mergeConflictCheckName,
				head_sha: headSha,
				status: 'completed',
				conclusion: output.conclusion,
				started_at: completedAt,
				completed_at: completedAt,
				details_url: input.detailsUrl,
				output: {
					title: output.title,
					summary: output.summary,
				},
			})
		},
	}
}

async function publishCheckAfterError(
	client: GithubClient,
	headSha: string,
	message: string,
) {
	try {
		await client.publishCheck(headSha, {
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

function isGithubRateLimitMessage(message: string) {
	return /failed \((403|429)\):/.test(message) && /rate limit/i.test(message)
}

function isGithubRateLimitResponse(status: number, body: string) {
	return (status === 403 || status === 429) && /rate limit/i.test(body)
}

function githubRateLimitWaitMs(response: Response) {
	const retryAfter = response.headers.get('retry-after')
	if (retryAfter !== null) {
		if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000
		const until = Date.parse(retryAfter)
		if (!Number.isNaN(until)) {
			return Math.max(githubRateLimitDefaultWaitMs, until - Date.now())
		}
	}
	const reset = response.headers.get('x-ratelimit-reset')
	if (reset !== null && /^\d+$/.test(reset)) {
		return Math.max(
			githubRateLimitDefaultWaitMs,
			Number(reset) * 1000 - Date.now(),
		)
	}
	return githubRateLimitDefaultWaitMs
}

function githubApiErrorMessage(
	method: string,
	path: string,
	status: number,
	body: string,
) {
	return `GitHub API ${method} ${path} failed (${String(status)}): ${body.slice(0, 500)}`
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
		base?: { ref?: unknown; sha?: unknown }
	}
	const mergeable =
		record.mergeable === null || typeof record.mergeable === 'boolean'
			? record.mergeable
			: null
	const mergeableState =
		typeof record.mergeable_state === 'string' ? record.mergeable_state : ''
	const baseRef = typeof record.base?.ref === 'string' ? record.base.ref : ''
	const baseSha =
		typeof record.base?.sha === 'string' &&
		/^[0-9a-f]{40}$/i.test(record.base.sha)
			? record.base.sha
			: ''
	return {
		mergeable,
		mergeableState,
		baseRef,
		baseSha,
		draft: record.draft === true,
	}
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
}
