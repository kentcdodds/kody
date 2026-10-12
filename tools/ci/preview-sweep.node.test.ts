import { expect, test } from 'vitest'
import {
	collectPreviewPullRequestNumbers,
	listPreviewCandidateNames,
	planPreviewSweep,
	previewPullRequestNumber,
	readPullRequestState,
	type PullRequestState,
} from './preview-sweep.ts'

test('previewPullRequestNumber reads only names inside the preview naming scheme', () => {
	expect(previewPullRequestNumber('kody-pr-3395')).toBe(3395)
	expect(previewPullRequestNumber('kody-pr-3395-platform')).toBe(3395)
	expect(previewPullRequestNumber('kody-pr-12-audit-db')).toBe(12)
	expect(previewPullRequestNumber('kody-pr-12-mock-cloudflare')).toBe(12)

	for (const name of [
		'kody',
		'kody-platform',
		'kody-production',
		'kody-pr-preview',
		'kody-pr-',
		'kody-pr-0',
		'kody-pr-12x',
		'kody-branch-teams-rehearsal',
		'kody-branch-12',
		'kody-pr-12-Platform_MCP',
		'other-pr-12',
	]) {
		expect({ name, number: previewPullRequestNumber(name) }).toEqual({
			name,
			number: null,
		})
	}
})

test('collectPreviewPullRequestNumbers dedupes and sorts PR numbers', () => {
	expect(
		collectPreviewPullRequestNumbers([
			'kody-pr-30-runtime',
			'kody',
			'kody-pr-4',
			'kody-pr-30',
			'kody-pr-4-db',
			'kody-branch-x',
		]),
	).toEqual([4, 30])
})

test('planPreviewSweep sweeps closed PRs oldest first up to the cap', () => {
	const states = new Map<number, PullRequestState>([
		[1, 'closed'],
		[2, 'open'],
		[3, 'closed'],
		[4, 'unknown'],
		[5, 'closed'],
	])
	expect(
		planPreviewSweep({
			pullRequestNumbers: [1, 2, 3, 4, 5, 6],
			states,
			maxPerRun: 2,
		}),
	).toEqual({
		sweep: [1, 3],
		deferred: [5],
		open: [2],
		unknown: [4, 6],
	})
	expect(
		planPreviewSweep({ pullRequestNumbers: [1], states, maxPerRun: 0 }).sweep,
	).toEqual([])
})

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

test('listPreviewCandidateNames reads scripts, namespace owners, and paged D1 names', async () => {
	const requested: Array<string> = []
	const fetcher = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input))
		requested.push(`${url.pathname}${url.search}`)
		if (url.pathname.endsWith('/workers/scripts')) {
			return jsonResponse({
				success: true,
				result: [{ id: 'kody-pr-7' }, { id: 'kody' }],
			})
		}
		if (url.pathname.endsWith('/workers/durable_objects/namespaces')) {
			return jsonResponse({
				success: true,
				result: [
					{ script: 'kody-pr-8-platform', name: 'kody-pr-8-platform_MCP' },
				],
				result_info: { total_pages: 1 },
			})
		}
		if (url.pathname.endsWith('/d1/database')) {
			const page = url.searchParams.get('page')
			const perPage = Number(url.searchParams.get('per_page'))
			return jsonResponse({
				success: true,
				result:
					page === '1'
						? Array.from({ length: perPage }, (_, index) => ({
								name: index === 0 ? 'kody-pr-9-db' : `other-${String(index)}`,
							}))
						: [{ name: 'kody-pr-10-audit-db' }],
			})
		}
		return jsonResponse({ success: false, errors: [{ message: 'nope' }] }, 404)
	}) as typeof fetch

	const names = await listPreviewCandidateNames({
		accountId: 'acct',
		apiToken: 'token',
		fetcher,
	})
	expect(collectPreviewPullRequestNumbers(names)).toEqual([7, 8, 9, 10])
	expect(requested).toEqual([
		'/client/v4/accounts/acct/workers/scripts',
		'/client/v4/accounts/acct/workers/durable_objects/namespaces?page=1&per_page=1000',
		'/client/v4/accounts/acct/d1/database?page=1&per_page=100',
		'/client/v4/accounts/acct/d1/database?page=2&per_page=100',
	])
})

test('readPullRequestState maps GitHub responses and treats 404 as unknown', async () => {
	const read = (response: Response) =>
		readPullRequestState({
			repository: 'kentcdodds/kody',
			number: 1,
			githubToken: 'token',
			fetcher: (async () => response) as typeof fetch,
		})
	await expect(read(jsonResponse({ state: 'closed' }))).resolves.toBe('closed')
	await expect(read(jsonResponse({ state: 'open' }))).resolves.toBe('open')
	await expect(read(jsonResponse({}, 404))).resolves.toBe('unknown')
	await expect(read(jsonResponse({}, 502))).rejects.toThrow(/502/)
})
