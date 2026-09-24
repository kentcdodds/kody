import { appendFileSync, readFileSync } from 'node:fs'

import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * GitHub does not create `pull_request` workflow runs while a PR has merge
 * conflicts, including `synchronize` (force-push and fast-forward) and
 * `ready_for_review`. Validate and Preview listen to those events, so a
 * conflicted head gets no checks. Callers enqueue the reusable workflows
 * from `push` and `pull_request_target` (`ready_for_review`) only in that
 * gap. A mergeable PR skips so the `pull_request` run stays the only one.
 * Forks and drafts never enqueue: `pull_request_target` must not hand this
 * repo's secrets to a fork.
 */

const mergeablePollAttempts = 8
const mergeablePollDelayMs = 3_000

export type OpenPullRequest = {
	number: number
	draft: boolean
	fork: boolean
	baseRef: string
	mergeable: boolean | null
	baseSha: string
	headSha: string
	title: string
	url: string
}

export type EnqueueSkipReason =
	| 'event'
	| 'no-pr'
	| 'fork'
	| 'draft'
	| 'base'
	| 'mergeable'

export type EnqueueDecision =
	| { action: 'skip'; reason: EnqueueSkipReason }
	| { action: 'wait' }
	| {
			action: 'enqueue'
			reason: 'conflict' | 'mergeable-unknown'
			pullRequest: OpenPullRequest
	  }

export function enqueueTriggerEvent(eventName: string) {
	return eventName === 'push' || eventName === 'pull_request_target'
}

export function selectOpenPullRequest(
	pulls: ReadonlyArray<OpenPullRequest>,
	baseRef = 'main',
): OpenPullRequest | null {
	const onBase = pulls.filter((pull) => pull.baseRef === baseRef)
	const ready = onBase.filter((pull) => !pull.fork && !pull.draft)
	if (ready.length > 0) return lowestNumber(ready)
	const drafts = onBase.filter((pull) => !pull.fork && pull.draft)
	if (drafts.length > 0) return lowestNumber(drafts)
	const forks = onBase.filter((pull) => pull.fork)
	if (forks.length > 0) return lowestNumber(forks)
	return null
}

export function decidePrCheckEnqueue(
	pullRequest: OpenPullRequest | null,
	pollExhausted: boolean,
): EnqueueDecision {
	if (!pullRequest) return { action: 'skip', reason: 'no-pr' }
	if (pullRequest.fork) return { action: 'skip', reason: 'fork' }
	if (pullRequest.draft) return { action: 'skip', reason: 'draft' }
	if (pullRequest.baseRef !== 'main') return { action: 'skip', reason: 'base' }
	if (pullRequest.mergeable === true) {
		return { action: 'skip', reason: 'mergeable' }
	}
	if (pullRequest.mergeable === false) {
		return { action: 'enqueue', reason: 'conflict', pullRequest }
	}
	if (!pollExhausted) return { action: 'wait' }
	return { action: 'enqueue', reason: 'mergeable-unknown', pullRequest }
}

export function openPullRequestFromPayload(
	value: unknown,
): OpenPullRequest | null {
	if (!isRecord(value)) return null
	const number = value.number
	const base = isRecord(value.base) ? value.base : null
	const head = isRecord(value.head) ? value.head : null
	const headRepo = head && isRecord(head.repo) ? head.repo : null
	if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
		return null
	}
	if (!base || typeof base.ref !== 'string' || typeof base.sha !== 'string') {
		return null
	}
	if (!head || typeof head.sha !== 'string') return null
	return {
		number,
		draft: value.draft === true,
		// Missing head repo cannot be shown to be same-repo. Treat it as a
		// fork so enqueue refuses rather than checking out unknown code.
		fork: headRepo?.fork !== false,
		baseRef: base.ref,
		mergeable: typeof value.mergeable === 'boolean' ? value.mergeable : null,
		baseSha: base.sha,
		headSha: head.sha,
		title: typeof value.title === 'string' ? value.title : '',
		url: typeof value.html_url === 'string' ? value.html_url : '',
	}
}

function lowestNumber(pulls: ReadonlyArray<OpenPullRequest>) {
	return pulls.reduce((best, pull) => (pull.number < best.number ? pull : best))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

type GithubClient = {
	getJson: (path: string) => Promise<unknown>
	sleep: (ms: number) => Promise<void>
}

export async function resolvePrCheckEnqueue(input: {
	eventName: string
	branch: string
	repository: string
	eventPullNumber: number | null
	github: GithubClient
}): Promise<EnqueueDecision> {
	if (!enqueueTriggerEvent(input.eventName)) {
		return { action: 'skip', reason: 'event' }
	}
	const [owner] = input.repository.split('/')
	if (!owner) return { action: 'skip', reason: 'no-pr' }

	const load = async () => {
		if (input.eventPullNumber !== null) {
			return openPullRequestFromPayload(
				await input.github.getJson(
					`/repos/${input.repository}/pulls/${input.eventPullNumber}`,
				),
			)
		}
		const listed = await input.github.getJson(
			`/repos/${input.repository}/pulls?state=open&per_page=20&head=${encodeURIComponent(`${owner}:${input.branch}`)}`,
		)
		const pulls = Array.isArray(listed)
			? listed.flatMap((entry) => {
					const pull = openPullRequestFromPayload(entry)
					return pull ? [pull] : []
				})
			: []
		const selected = selectOpenPullRequest(pulls)
		if (!selected) return null
		return (
			openPullRequestFromPayload(
				await input.github.getJson(
					`/repos/${input.repository}/pulls/${selected.number}`,
				),
			) ?? selected
		)
	}

	let pullRequest = await load()
	let decision = decidePrCheckEnqueue(pullRequest, false)
	for (
		let attempt = 0;
		attempt < mergeablePollAttempts && decision.action === 'wait';
		attempt++
	) {
		await input.github.sleep(mergeablePollDelayMs)
		pullRequest = await load()
		decision = decidePrCheckEnqueue(pullRequest, false)
	}
	if (decision.action === 'wait') {
		decision = decidePrCheckEnqueue(pullRequest, true)
	}
	return decision
}

function writeOutput(name: string, value: string) {
	const line = `${name}=${value}\n`
	const outputPath = process.env.GITHUB_OUTPUT
	if (outputPath) {
		appendFileSync(outputPath, line)
		return
	}
	process.stdout.write(line)
}

function eventPullNumber(eventName: string, event: unknown) {
	if (eventName !== 'pull_request_target' || !isRecord(event)) return null
	const pullRequest = isRecord(event.pull_request) ? event.pull_request : null
	const number = pullRequest?.number
	return typeof number === 'number' ? number : null
}

async function main() {
	const eventName = process.env.GITHUB_EVENT_NAME ?? ''
	const repository = process.env.GITHUB_REPOSITORY ?? ''
	const token = process.env.GITHUB_TOKEN ?? ''
	const apiUrl = (
		process.env.GITHUB_API_URL ?? 'https://api.github.com'
	).replace(/\/$/, '')
	if (!repository || !token) {
		throw new Error(
			'pr-check-enqueue requires GITHUB_REPOSITORY and GITHUB_TOKEN',
		)
	}
	const eventPath = process.env.GITHUB_EVENT_PATH
	const event = eventPath
		? (JSON.parse(readFileSync(eventPath, 'utf8')) as unknown)
		: null
	const decision = await resolvePrCheckEnqueue({
		eventName,
		branch: process.env.GITHUB_REF_NAME ?? '',
		repository,
		eventPullNumber: eventPullNumber(eventName, event),
		github: {
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			getJson: async (path) => {
				const response = await fetch(`${apiUrl}${path}`, {
					headers: {
						Accept: 'application/vnd.github+json',
						Authorization: `Bearer ${token}`,
						'User-Agent': 'kody-pr-check-enqueue',
						'X-GitHub-Api-Version': '2022-11-28',
					},
				})
				if (!response.ok) {
					throw new Error(
						`pr-check-enqueue GitHub ${path} failed: HTTP ${response.status}`,
					)
				}
				return (await response.json()) as unknown
			},
		},
	})
	console.log(
		`pr-check-enqueue: ${decision.action}${decision.action === 'wait' ? '' : ` ${decision.reason}`}`,
	)
	switch (decision.action) {
		case 'wait':
			throw new Error('pr-check-enqueue: mergeable still unknown after polling')
		case 'skip':
			writeOutput('enqueue', 'false')
			writeOutput('reason', decision.reason)
			writeOutput('pr_number', '')
			writeOutput('base_sha', '')
			writeOutput('head_sha', '')
			return
		case 'enqueue':
			writeOutput('enqueue', 'true')
			writeOutput('reason', decision.reason)
			writeOutput('pr_number', String(decision.pullRequest.number))
			writeOutput('base_sha', decision.pullRequest.baseSha)
			writeOutput('head_sha', decision.pullRequest.headSha)
			return
		default: {
			const neverDecision: never = decision
			throw new Error(
				`pr-check-enqueue: unhandled ${JSON.stringify(neverDecision)}`,
			)
		}
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
