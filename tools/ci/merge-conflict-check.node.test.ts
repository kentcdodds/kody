import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	classifyMergeability,
	describeMergeConflictCheck,
	main,
	mergeConflictCheckName,
	pollMergeability,
	reportMergeConflictCheck,
	reportOpenPullRequestMergeConflicts,
	type PullRequestMergeability,
} from './merge-conflict-check.ts'

const headSha = 'a'.repeat(40)

test('only a dirty pull request is treated as a merge conflict', () => {
	expect(
		classifyMergeability({ mergeable: false, mergeableState: 'dirty' }),
	).toBe('conflicted')
	expect(
		classifyMergeability({ mergeable: null, mergeableState: 'dirty' }),
	).toBe('conflicted')

	for (const mergeableState of [
		'clean',
		'behind',
		'blocked',
		'unstable',
		'draft',
		'has_hooks',
	]) {
		expect(classifyMergeability({ mergeable: true, mergeableState })).toBe(
			'clear',
		)
	}

	expect(
		classifyMergeability({ mergeable: null, mergeableState: 'unknown' }),
	).toBe('pending')
	expect(classifyMergeability({ mergeable: null, mergeableState: '' })).toBe(
		'pending',
	)
	expect(
		classifyMergeability({ mergeable: false, mergeableState: 'blocked' }),
	).toBe('clear')
})

test('conflict copy tells the author to merge the base branch', () => {
	const conflicted = describeMergeConflictCheck({
		kind: 'conflicted',
		baseRef: 'main',
		mergeableState: 'dirty',
		draft: false,
	})
	expect(conflicted.conclusion).toBe('failure')
	expect(conflicted.title).toBe('Conflicts with main')
	expect(conflicted.summary).toContain('Validate, Preview, or CLA')
	expect(conflicted.summary).toContain('Merge main into this branch')

	const draft = describeMergeConflictCheck({
		kind: 'clear',
		baseRef: 'not a ref\n',
		mergeableState: 'draft',
		draft: true,
	})
	expect(draft.conclusion).toBe('success')
	expect(draft.title).toBe('No conflicts with its base branch')
	expect(draft.summary).toContain('ready for review')

	const unknown = describeMergeConflictCheck({
		kind: 'undetermined',
		baseRef: 'main',
		mergeableState: 'unknown',
		draft: false,
		detail: 'GitHub API GET failed',
	})
	expect(unknown.conclusion).toBe('failure')
	expect(unknown.summary).toContain(mergeConflictCheckName)
	expect(unknown.summary).toContain('GitHub API GET failed')
})

test('polling waits until GitHub finishes computing mergeability', async () => {
	const reads = [
		mergeability({ mergeable: null, mergeableState: 'unknown' }),
		mergeability({ mergeable: true, mergeableState: 'behind' }),
	]
	const sleeps: Array<number> = []
	const result = await pollMergeability({
		read: () => {
			const next = reads.shift()
			if (!next) throw new Error('missing mergeability fixture')
			return Promise.resolve(next)
		},
		sleep: (ms) => {
			sleeps.push(ms)
			return Promise.resolve()
		},
		maxAttempts: 3,
		delayMs: 25,
	})
	expect(result.kind).toBe('clear')
	expect(result.mergeableState).toBe('behind')
	expect(sleeps).toEqual([25])
})

test('polling fails closed when mergeability stays unknown', async () => {
	let reads = 0
	const result = await pollMergeability({
		read: () => {
			reads += 1
			return Promise.resolve(
				mergeability({ mergeable: null, mergeableState: 'unknown' }),
			)
		},
		sleep: () => Promise.resolve(),
		maxAttempts: 3,
		delayMs: 1,
	})
	expect(result.kind).toBe('undetermined')
	expect(reads).toBe(3)
})

test('a dirty pull request fails a check on the head SHA', async () => {
	const github = fakeGithub([
		pull({ mergeable: false, mergeable_state: 'dirty', draft: true }),
	])
	const code = await reportMergeConflictCheck({
		token: 'test-token',
		repository: 'kentcdodds/kody',
		pullNumber: 2483,
		headSha,
		detailsUrl: 'https://github.com/kentcdodds/kody/actions/runs/7',
		fetchImpl: github.fetchImpl,
		sleep: () => Promise.resolve(),
		maxAttempts: 2,
		delayMs: 1,
	})
	expect(code).toBe(0)
	expect(github.calls.map((call) => call.method)).toEqual([
		'POST',
		'GET',
		'PATCH',
	])
	expect(github.calls[0]?.body).toMatchObject({
		name: mergeConflictCheckName,
		head_sha: headSha,
		status: 'in_progress',
		details_url: 'https://github.com/kentcdodds/kody/actions/runs/7',
	})
	expect(github.calls[1]?.url).toBe(
		'https://api.github.com/repos/kentcdodds/kody/pulls/2483',
	)
	expect(github.calls[2]?.body).toMatchObject({
		status: 'completed',
		conclusion: 'failure',
		output: {
			title: 'Conflicts with main',
		},
	})
	const summary = checkSummary(github.calls[2]?.body)
	expect(summary).toContain('ready for review')
	expect(github.calls[0]?.authorization).toBe('Bearer test-token')
})

test('a mergeable pull request completes the check successfully', async () => {
	const github = fakeGithub([
		pull({ mergeable: null, mergeable_state: 'unknown' }),
		pull({ mergeable: true, mergeable_state: 'clean' }),
	])
	const code = await reportMergeConflictCheck({
		token: 'test-token',
		repository: 'kentcdodds/kody',
		pullNumber: 12,
		headSha,
		fetchImpl: github.fetchImpl,
		sleep: () => Promise.resolve(),
		maxAttempts: 4,
		delayMs: 1,
	})
	expect(code).toBe(0)
	expect(github.calls[3]?.body).toMatchObject({
		conclusion: 'success',
		output: { title: 'No conflicts with main' },
	})
})

test('an API error completes the open check as a failure', async () => {
	const github = fakeGithub([
		pull({ mergeable: null, mergeable_state: 'unknown' }),
	])
	github.failPulls = true
	consoleError.mockImplementation(() => {})
	const code = await reportMergeConflictCheck({
		token: 'test-token',
		repository: 'kentcdodds/kody',
		pullNumber: 12,
		headSha,
		fetchImpl: github.fetchImpl,
		sleep: () => Promise.resolve(),
		maxAttempts: 1,
	})
	expect(code).toBe(0)
	expect(github.calls.at(-1)?.body).toMatchObject({
		conclusion: 'failure',
		output: { title: 'Mergeability unavailable' },
	})
	const errors = consoleError.mock.calls
		.map((call) => String(call[0]))
		.join('\n')
	expect(errors).toContain('failed (503)')
	expect(errors).not.toContain('test-token')
})

test('a failed check creation still fails the process', async () => {
	const calls: Array<string> = []
	const fetchImpl: typeof fetch = (_input, init) => {
		calls.push(init?.method ?? 'GET')
		return Promise.resolve(new Response('nope', { status: 500 }))
	}
	consoleError.mockImplementation(() => {})
	const code = await reportMergeConflictCheck({
		token: 'test-token',
		repository: 'kentcdodds/kody',
		pullNumber: 12,
		headSha,
		fetchImpl,
	})
	expect(code).toBe(1)
	expect(calls).toEqual(['POST'])
	const errors = consoleError.mock.calls
		.map((call) => String(call[0]))
		.join('\n')
	expect(errors).toContain('failed (500)')
	expect(errors).not.toContain('test-token')
})

test('main fails closed when the head SHA is missing', async () => {
	const previousExitCode = process.exitCode
	consoleError.mockImplementation(() => {})
	try {
		await main({
			GITHUB_TOKEN: 'test-token',
			GITHUB_REPOSITORY: 'kentcdodds/kody',
			PR_NUMBER: '12',
			HEAD_SHA: 'short',
		})
		expect(process.exitCode).toBe(1)
	} finally {
		process.exitCode = previousExitCode
	}
})

test('a base-branch push refreshes every open pull request head check', async () => {
	const dirtySha = 'a'.repeat(40)
	const cleanSha = 'b'.repeat(40)
	const calls: Array<{ method: string; url: string; body: unknown }> = []
	const fetchImpl: typeof fetch = (input, init) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const body =
			typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
		calls.push({ method, url, body })
		if (url.includes('/pulls?')) {
			return Promise.resolve(
				Response.json([
					{ number: 7, head: { sha: dirtySha } },
					{ number: 8, head: { sha: cleanSha } },
				]),
			)
		}
		if (url.endsWith('/pulls/7')) {
			return Promise.resolve(
				Response.json(pull({ mergeable: false, mergeable_state: 'dirty' })),
			)
		}
		if (url.endsWith('/pulls/8')) {
			return Promise.resolve(
				Response.json(pull({ mergeable: true, mergeable_state: 'clean' })),
			)
		}
		if (method === 'POST' && url.endsWith('/check-runs')) {
			return Promise.resolve(Response.json({ id: calls.length }))
		}
		if (method === 'PATCH') {
			return Promise.resolve(Response.json({ id: 1 }))
		}
		return Promise.resolve(new Response('unexpected', { status: 500 }))
	}
	const code = await reportOpenPullRequestMergeConflicts({
		token: 'test-token',
		repository: 'kentcdodds/kody',
		baseRef: 'main',
		fetchImpl,
		sleep: () => Promise.resolve(),
		maxAttempts: 2,
		concurrency: 2,
	})
	expect(code).toBe(0)
	const list = calls.find((call) => call.url.includes('/pulls?'))
	expect(list?.url).toContain('state=open')
	expect(list?.url).toContain('base=main')
	const headShas = calls
		.filter((call) => call.method === 'POST')
		.map((call) => headShaFrom(call.body))
		.sort()
	expect(headShas).toEqual([cleanSha, dirtySha].sort())
	const conclusions = calls
		.filter((call) => call.method === 'PATCH')
		.map((call) => conclusionFrom(call.body))
		.sort()
	expect(conclusions).toEqual(['failure', 'success'])
})

test('an open pull request scan fails closed when the list is unreadable', async () => {
	const fetchImpl: typeof fetch = () =>
		Promise.resolve(Response.json({ unexpected: true }))
	await expect(
		reportOpenPullRequestMergeConflicts({
			token: 'test-token',
			repository: 'kentcdodds/kody',
			baseRef: 'main',
			fetchImpl,
			maxAttempts: 1,
		}),
	).rejects.toThrow('Open pull request list was not an array')
})

test('main fails closed for an unknown mode or a scan without a base ref', async () => {
	const previousExitCode = process.exitCode
	consoleError.mockImplementation(() => {})
	try {
		await main({
			GITHUB_TOKEN: 'test-token',
			GITHUB_REPOSITORY: 'kentcdodds/kody',
			MERGE_CONFLICT_MODE: 'open-pulls',
		})
		expect(process.exitCode).toBe(1)
		process.exitCode = 0
		await main({
			GITHUB_TOKEN: 'test-token',
			GITHUB_REPOSITORY: 'kentcdodds/kody',
			MERGE_CONFLICT_MODE: 'validate',
			PR_NUMBER: '12',
			HEAD_SHA: headSha,
		})
		expect(process.exitCode).toBe(1)
	} finally {
		process.exitCode = previousExitCode
	}
})

test('the workflow posts the check from the default branch and does not run pull request code', () => {
	const workflow = readFileSync('.github/workflows/merge-conflicts.yml', 'utf8')
	const source = readFileSync('tools/ci/merge-conflict-check.ts', 'utf8')
	expect(workflow).toContain('name: Report merge conflicts')
	expect(workflow).toContain('pull_request_target:')
	expect(workflow).toContain('push:')
	expect(workflow).toContain('- edited')
	expect(workflow).toContain('github.event.changes.base')
	expect(workflow).toContain('github.event.changes.base.ref.from')
	expect(workflow).toContain("'open-pulls'")
	const pullRequestTarget = workflow.slice(
		workflow.indexOf('pull_request_target:'),
	)
	expect(pullRequestTarget).not.toContain('\n    branches:')
	expect(workflow).not.toContain('npm run validate')
	expect(workflow).toContain(
		'ref: ${{ github.event.repository.default_branch }}',
	)
	expect(workflow).toContain('persist-credentials: false')
	expect(workflow).toContain('checks: write')
	expect(workflow).not.toContain('contents: write')
	expect(workflow).not.toContain('pull-requests: write')
	expect(workflow).not.toContain('actions: write')
	expect(workflow).not.toMatch(
		/ref:\s*\$\{\{\s*github\.event\.pull_request\.head/,
	)
	expect(source).not.toContain('child_process')
	expect(source).not.toContain('execSync')
})

function mergeability(input: {
	mergeable: boolean | null
	mergeableState: string
	draft?: boolean
}): PullRequestMergeability {
	return {
		mergeable: input.mergeable,
		mergeableState: input.mergeableState,
		baseRef: 'main',
		draft: input.draft ?? false,
	}
}

function pull(input: {
	mergeable: boolean | null
	mergeable_state: string
	draft?: boolean
}) {
	return {
		mergeable: input.mergeable,
		mergeable_state: input.mergeable_state,
		draft: input.draft ?? false,
		base: { ref: 'main' },
	}
}

type RecordedCall = {
	method: string
	url: string
	authorization: string | null
	body: unknown
}

function fakeGithub(pulls: Array<ReturnType<typeof pull>>): {
	fetchImpl: typeof fetch
	calls: Array<RecordedCall>
	failPulls: boolean
} {
	const calls: Array<RecordedCall> = []
	let pullIndex = 0
	const state: { failPulls: boolean } = { failPulls: false }
	const fetchImpl: typeof fetch = (input, init) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const headers = new Headers(init?.headers)
		const body =
			typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
		calls.push({
			method,
			url,
			authorization: headers.get('authorization'),
			body,
		})
		if (url.includes('/pulls/')) {
			if (state.failPulls) {
				return Promise.resolve(new Response('unavailable', { status: 503 }))
			}
			const payload = pulls[Math.min(pullIndex, pulls.length - 1)]
			pullIndex += 1
			return Promise.resolve(Response.json(payload))
		}
		if (method === 'POST' && url.endsWith('/check-runs')) {
			return Promise.resolve(Response.json({ id: 99 }))
		}
		if (method === 'PATCH') {
			return Promise.resolve(Response.json({ id: 99 }))
		}
		return Promise.resolve(new Response('unexpected', { status: 500 }))
	}
	return {
		fetchImpl,
		calls,
		get failPulls() {
			return state.failPulls
		},
		set failPulls(value: boolean) {
			state.failPulls = value
		},
	}
}

function headShaFrom(body: unknown) {
	if (typeof body !== 'object' || body === null || !('head_sha' in body)) {
		return ''
	}
	return typeof body.head_sha === 'string' ? body.head_sha : ''
}

function conclusionFrom(body: unknown) {
	if (typeof body !== 'object' || body === null || !('conclusion' in body)) {
		return ''
	}
	return typeof body.conclusion === 'string' ? body.conclusion : ''
}

function checkSummary(body: unknown) {
	if (typeof body !== 'object' || body === null || !('output' in body)) {
		return ''
	}
	const output = body.output
	if (typeof output !== 'object' || output === null || !('summary' in output)) {
		return ''
	}
	return typeof output.summary === 'string' ? output.summary : ''
}
