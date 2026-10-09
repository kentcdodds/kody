import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	classifyMergeability,
	main,
	mergeConflictCheckName,
	pollMergeability,
	reportMergeConflictCheck,
	reportOpenPullRequestMergeConflicts,
	type PullRequestMergeability,
} from './merge-conflict-check.ts'

const headSha = 'a'.repeat(40)
const baseSha = 'c'.repeat(40)
const previousBaseSha = 'd'.repeat(40)
const repo = {
	token: 'test-token',
	repository: 'kentcdodds/kody',
	expectedBaseSha: baseSha,
	sleep: () => Promise.resolve(),
}

test('only a dirty pull request is treated as a merge conflict', () => {
	type Case = [
		Parameters<typeof classifyMergeability>[0],
		ReturnType<typeof classifyMergeability>,
	]
	const cases: Array<Case> = [
		[{ mergeable: false, mergeableState: 'dirty' }, 'conflicted'],
		[{ mergeable: null, mergeableState: 'dirty' }, 'conflicted'],
		...['clean', 'behind', 'blocked', 'unstable', 'draft', 'has_hooks'].map(
			(mergeableState): Case => [{ mergeable: true, mergeableState }, 'clear'],
		),
		[{ mergeable: null, mergeableState: 'unknown' }, 'pending'],
		[{ mergeable: null, mergeableState: '' }, 'pending'],
		[{ mergeable: false, mergeableState: 'blocked' }, 'clear'],
	]
	expect(
		cases.filter(([input, want]) => classifyMergeability(input) !== want),
	).toEqual([])
})

test('polling prefers a computed state on the expected base tip, then falls back or fails closed', async () => {
	const unknown = mergeability({ mergeable: null, mergeableState: 'unknown' })
	const cases = [
		{
			scenario: 'waits until GitHub finishes computing',
			sequence: [
				unknown,
				mergeability({ mergeable: true, mergeableState: 'behind' }),
			],
			maxAttempts: 3,
			expected: { kind: 'clear', mergeableState: 'behind', reads: 2 },
		},
		{
			scenario: 'fails closed when mergeability stays unknown',
			sequence: [unknown],
			maxAttempts: 3,
			expected: { kind: 'undetermined', mergeableState: 'unknown', reads: 3 },
		},
		{
			scenario: 'ignores a cached result for the previous base tip',
			sequence: [
				mergeability({
					mergeable: true,
					mergeableState: 'clean',
					baseSha: previousBaseSha,
				}),
				mergeability({ mergeable: false, mergeableState: 'dirty' }),
			],
			maxAttempts: 3,
			expected: { kind: 'conflicted', mergeableState: 'dirty', reads: 2 },
		},
		{
			scenario: 'accepts behind when the base SHA never matches',
			sequence: [
				mergeability({
					mergeable: true,
					mergeableState: 'behind',
					baseSha: previousBaseSha,
				}),
			],
			maxAttempts: 2,
			expected: { kind: 'clear', mergeableState: 'behind', reads: 2 },
		},
		{
			scenario: 'accepts dirty when the base SHA never matches',
			sequence: [
				mergeability({
					mergeable: false,
					mergeableState: 'dirty',
					baseSha: previousBaseSha,
				}),
			],
			maxAttempts: 2,
			expected: { kind: 'conflicted', mergeableState: 'dirty', reads: 2 },
		},
	]
	const results = []
	for (const { scenario, sequence, maxAttempts } of cases) {
		let reads = 0
		const sleeps: Array<number> = []
		const result = await pollMergeability({
			read: () => {
				const next = sequence[Math.min(reads, sequence.length - 1)]
				reads += 1
				if (!next) throw new Error('missing mergeability fixture')
				return Promise.resolve(next)
			},
			sleep: (ms) => {
				sleeps.push(ms)
				return Promise.resolve()
			},
			maxAttempts,
			delayMs: 25,
			expectedBaseSha: baseSha,
		})
		results.push({
			scenario,
			kind: result.kind,
			mergeableState: result.mergeableState,
			reads,
			sleeps,
			detail: result.detail,
		})
	}
	expect(results).toEqual(
		cases.map(({ scenario, expected }) => ({
			scenario,
			...expected,
			sleeps: Array.from({ length: expected.reads - 1 }, () => 25),
			detail: undefined,
		})),
	)
})

test('a dirty pull request fails a check on the head SHA', async () => {
	const github = fakeGithub({
		pulls: {
			2483: [pull({ mergeable: false, mergeable_state: 'dirty', draft: true })],
		},
	})
	const code = await reportMergeConflictCheck({
		...repo,
		pullNumber: 2483,
		headSha,
		detailsUrl: 'https://github.com/kentcdodds/kody/actions/runs/7',
		fetchImpl: github.fetchImpl,
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
		output: { title: 'Conflicts with main' },
	})
	expect(github.calls[0]?.authorization).toBe('Bearer test-token')
})

test('a mergeable pull request completes the check successfully', async () => {
	const github = fakeGithub({
		pulls: {
			12: [
				pull({ mergeable: null, mergeable_state: 'unknown' }),
				pull({ mergeable: true, mergeable_state: 'clean' }),
			],
		},
	})
	const code = await reportMergeConflictCheck({
		...repo,
		pullNumber: 12,
		headSha,
		fetchImpl: github.fetchImpl,
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
	const github = fakeGithub({ pulls: {}, failPulls: true })
	consoleError.mockImplementation(() => {})
	const code = await reportMergeConflictCheck({
		...repo,
		pullNumber: 12,
		headSha,
		fetchImpl: github.fetchImpl,
		maxAttempts: 1,
	})
	expect(code).toBe(0)
	expect(github.calls.at(-1)?.body).toMatchObject({
		conclusion: 'failure',
		output: { title: 'Mergeability unavailable' },
	})
	expect(loggedErrors()).toContain('failed (503)')
	expect(loggedErrors()).not.toContain('test-token')
})

test('a failed check creation still fails the process', async () => {
	const methods: Array<string> = []
	consoleError.mockImplementation(() => {})
	const code = await reportMergeConflictCheck({
		...repo,
		pullNumber: 12,
		headSha,
		fetchImpl: (_input, init) => {
			methods.push(init?.method ?? 'GET')
			return Promise.resolve(new Response('nope', { status: 500 }))
		},
	})
	expect(code).toBe(1)
	expect(methods).toEqual(['POST'])
	expect(loggedErrors()).toContain('failed (500)')
	expect(loggedErrors()).not.toContain('test-token')
})

test('main fails closed for a bad head SHA, an unknown mode, or a scan without a base ref or SHA', async () => {
	const previousExitCode = process.exitCode
	consoleError.mockImplementation(() => {})
	const auth = {
		GITHUB_TOKEN: 'test-token',
		GITHUB_REPOSITORY: 'kentcdodds/kody',
	}
	const envs = [
		{ ...auth, PR_NUMBER: '12', HEAD_SHA: 'short' },
		{ ...auth, MERGE_CONFLICT_MODE: 'open-pulls' },
		{ ...auth, MERGE_CONFLICT_MODE: 'open-pulls', BASE_REF: 'main' },
		{
			...auth,
			MERGE_CONFLICT_MODE: 'validate',
			PR_NUMBER: '12',
			HEAD_SHA: headSha,
		},
	]
	try {
		const exitCodes = []
		for (const env of envs) {
			process.exitCode = 0
			await main(env)
			exitCodes.push(process.exitCode)
		}
		expect(exitCodes).toEqual(envs.map(() => 1))
	} finally {
		process.exitCode = previousExitCode
	}
})

test('a base-branch push refreshes every open pull request head check', async () => {
	const cleanSha = 'b'.repeat(40)
	const github = fakeGithub({
		openPulls: [
			{ number: 7, head: { sha: headSha } },
			{ number: 8, head: { sha: cleanSha } },
		],
		pulls: {
			7: [pull({ mergeable: false, mergeable_state: 'dirty' })],
			8: [pull({ mergeable: true, mergeable_state: 'clean' })],
		},
	})
	const code = await reportOpenPullRequestMergeConflicts({
		...repo,
		baseRef: 'main',
		fetchImpl: github.fetchImpl,
		maxAttempts: 2,
		concurrency: 2,
	})
	expect(code).toBe(0)
	const list = github.calls.find((call) => call.url.includes('/pulls?'))
	expect(list?.url).toContain('state=open')
	expect(list?.url).toContain('base=main')
	expect(github.bodies('POST', 'head_sha').sort()).toEqual(
		[cleanSha, headSha].sort(),
	)
	expect(github.bodies('PATCH', 'conclusion').sort()).toEqual([
		'failure',
		'success',
	])
})

test('a base-branch push does not publish a cached result for the previous tip', async () => {
	const github = fakeGithub({
		openPulls: [{ number: 7, head: { sha: headSha } }],
		pulls: {
			7: [
				pull({
					mergeable: true,
					mergeable_state: 'clean',
					baseSha: previousBaseSha,
				}),
				pull({ mergeable: false, mergeable_state: 'dirty' }),
			],
		},
	})
	const code = await reportOpenPullRequestMergeConflicts({
		...repo,
		baseRef: 'main',
		fetchImpl: github.fetchImpl,
		maxAttempts: 3,
		concurrency: 1,
	})
	expect(code).toBe(0)
	expect(
		github.calls.filter((call) => call.url.endsWith('/pulls/7')),
	).toHaveLength(2)
	expect(github.bodies('PATCH', 'conclusion')).toEqual(['failure'])
})

test('an open pull request scan fails closed when the list is unreadable', async () => {
	await expect(
		reportOpenPullRequestMergeConflicts({
			...repo,
			baseRef: 'main',
			fetchImpl: () => Promise.resolve(Response.json({ unexpected: true })),
			maxAttempts: 1,
		}),
	).rejects.toThrow('Open pull request list was not an array')
})

function mergeability(input: {
	mergeable: boolean | null
	mergeableState: string
	baseSha?: string
}): PullRequestMergeability {
	return {
		mergeable: input.mergeable,
		mergeableState: input.mergeableState,
		baseRef: 'main',
		baseSha: input.baseSha ?? baseSha,
		draft: false,
	}
}

function pull(input: {
	mergeable: boolean | null
	mergeable_state: string
	draft?: boolean
	baseSha?: string
}) {
	return {
		mergeable: input.mergeable,
		mergeable_state: input.mergeable_state,
		draft: input.draft ?? false,
		base: { ref: 'main', sha: input.baseSha ?? baseSha },
	}
}

function loggedErrors() {
	return consoleError.mock.calls.map((call) => String(call[0])).join('\n')
}

type RecordedCall = {
	method: string
	url: string
	authorization: string | null
	body: unknown
}

/** Each pull's reads walk its fixture list and then repeat the last entry. */
function fakeGithub(input: {
	pulls: Record<number, Array<ReturnType<typeof pull>>>
	openPulls?: Array<{ number: number; head: { sha: string } }>
	failPulls?: boolean
}) {
	const calls: Array<RecordedCall> = []
	const fetchImpl: typeof fetch = (request, init) => {
		const url = String(request)
		const method = init?.method ?? 'GET'
		calls.push({
			method,
			url,
			authorization: new Headers(init?.headers).get('authorization'),
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
		})
		if (url.includes('/pulls?')) {
			return Promise.resolve(Response.json(input.openPulls ?? []))
		}
		const pullNumber = /\/pulls\/(\d+)$/.exec(url)?.[1]
		if (pullNumber) {
			if (input.failPulls) {
				return Promise.resolve(new Response('unavailable', { status: 503 }))
			}
			const fixtures = input.pulls[Number(pullNumber)] ?? []
			const reads = calls.filter((call) => call.url === url).length
			return Promise.resolve(
				Response.json(fixtures[Math.min(reads, fixtures.length) - 1]),
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
	return {
		fetchImpl,
		calls,
		bodies(method: string, field: 'head_sha' | 'conclusion') {
			return calls
				.filter((call) => call.method === method)
				.map((call) => {
					const body = call.body
					if (typeof body !== 'object' || body === null) return ''
					const value: unknown = Reflect.get(body, field)
					return typeof value === 'string' ? value : ''
				})
		},
	}
}
