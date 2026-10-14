import { expect, test } from 'vitest'
import {
	collectBranchPreviewSources,
	collectPreviewBranchWorkerNames,
	collectPreviewPullRequestNumbers,
	hasBudgetForAnotherCleanup,
	isPreviewDeployInProgress,
	listBranchPullRequests,
	listPreviewCandidateNames,
	planClosedSourceBranchSweep,
	planBranchPreviewSweep,
	planPreviewSweep,
	previewBranchSlug,
	previewBranchWorkerName,
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

test('previewBranchWorkerName reads the bare worker name from any branch-preview resource', () => {
	expect(previewBranchWorkerName('kody-branch-teams-rehearsal')).toBe(
		'kody-branch-teams-rehearsal',
	)
	expect(previewBranchWorkerName('kody-branch-teams-rehearsal-db')).toBe(
		'kody-branch-teams-rehearsal',
	)
	expect(
		previewBranchWorkerName('kody-branch-local-execute-parity-0092-audit-db'),
	).toBe('kody-branch-local-execute-parity-0092')

	for (const name of [
		'kody',
		'kody-platform',
		'kody-pr-12',
		'kody-pr-12-branch-x',
		'other-branch-x',
	]) {
		expect({ name, workerName: previewBranchWorkerName(name) }).toEqual({
			name,
			workerName: null,
		})
	}
})

test('collectPreviewBranchWorkerNames dedupes and sorts branch worker names', () => {
	expect(
		collectPreviewBranchWorkerNames([
			'kody-branch-b-runtime',
			'kody-pr-4',
			'kody-branch-a',
			'kody-branch-b',
			'kody-branch-a-db',
		]),
	).toEqual(['kody-branch-a', 'kody-branch-b'])
})

test('planBranchPreviewSweep sweeps orphaned branch previews up to the cap', () => {
	const liveNames = new Set(['kody-branch-live'])
	expect(
		planBranchPreviewSweep({
			branchWorkerNames: ['kody-branch-a', 'kody-branch-b', 'kody-branch-live'],
			liveNames,
			maxPerRun: 1,
		}),
	).toEqual({
		sweep: ['kody-branch-a'],
		deferred: ['kody-branch-b'],
		live: ['kody-branch-live'],
	})
	expect(
		planBranchPreviewSweep({
			branchWorkerNames: ['kody-branch-a'],
			liveNames: new Set(),
			maxPerRun: 0,
		}).sweep,
	).toEqual([])
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

test('listPreviewCandidateNames reads scripts, namespace owners, paged D1/KV names, and cursor-paged R2 buckets', async () => {
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
			// A short first page still has more when total_pages says so, and
			// the listing may wrap its items in `{ namespaces }`.
			return jsonResponse({
				success: true,
				result:
					url.searchParams.get('page') === '1'
						? {
								namespaces: [
									{
										script: 'kody-pr-8-platform',
										name: 'kody-pr-8-platform_MCP',
									},
								],
							}
						: [{ script: 'kody-pr-11-platform' }],
				result_info: { total_pages: 2 },
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
		if (url.pathname.endsWith('/storage/kv/namespaces')) {
			return jsonResponse({
				success: true,
				result: [{ title: 'kody-pr-12-oauth-kv' }],
				result_info: { total_pages: 1 },
			})
		}
		if (url.pathname.endsWith('/r2/buckets')) {
			return url.searchParams.get('cursor') === 'page-2'
				? jsonResponse({
						success: true,
						result: { buckets: [{ name: 'kody-pr-14-email-blobs' }] },
					})
				: jsonResponse({
						success: true,
						result: { buckets: [{ name: 'kody-pr-13-community-assets' }] },
						result_info: { cursor: 'page-2' },
					})
		}
		return jsonResponse({ success: false, errors: [{ message: 'nope' }] }, 404)
	}) as typeof fetch

	const { names, scriptNames } = await listPreviewCandidateNames({
		accountId: 'acct',
		apiToken: 'token',
		fetcher,
	})
	expect(collectPreviewPullRequestNumbers(names)).toEqual([
		7, 8, 9, 10, 11, 12, 13, 14,
	])
	// The Worker scripts listing is the only source of liveness (review
	// follow-up on #3563): it must never pick up D1/KV/R2/DO names.
	expect(scriptNames).toEqual(['kody-pr-7', 'kody'])
	expect(requested).toEqual([
		'/client/v4/accounts/acct/workers/scripts',
		'/client/v4/accounts/acct/workers/durable_objects/namespaces?page=1&per_page=100',
		'/client/v4/accounts/acct/workers/durable_objects/namespaces?page=2&per_page=100',
		'/client/v4/accounts/acct/d1/database?page=1&per_page=100',
		'/client/v4/accounts/acct/d1/database?page=2&per_page=100',
		'/client/v4/accounts/acct/storage/kv/namespaces?page=1&per_page=100',
		'/client/v4/accounts/acct/r2/buckets?per_page=1000',
		'/client/v4/accounts/acct/r2/buckets?per_page=1000&cursor=page-2',
	])
})

test('a dead origin with live siblings is still correctly swept, by design', () => {
	// A CodeRabbit follow-up on this same PR flagged that `kody-branch-foo-api`
	// being live strips to base `kody-branch-foo`, which the exact-match
	// liveness check in planBranchPreviewSweep then treats as orphaned if the
	// bare `kody-branch-foo` script itself is absent -- and that cleanup then
	// deletes `-api` too. That mechanism is accurate, but the conclusion that
	// it is a bug is not: `/workers/scripts` is a complete, account-wide
	// listing (re-fetched fresh immediately before this exact check), so the
	// only way a live origin's bare name can be absent from it is if the
	// origin genuinely is not deployed. Siblings-up-origin-down is precisely
	// the half-torn-down state #3563 was filed to sweep (see the file-level
	// comment above collectPreviewBranchWorkerNames); treating it as
	// protected would reintroduce #3563's original bug, where an orphaned
	// branch with lingering siblings is never swept.
	const branchWorkerNames = collectPreviewBranchWorkerNames([
		'kody-branch-foo-api',
	])
	expect(branchWorkerNames).toEqual(['kody-branch-foo'])
	expect(
		planBranchPreviewSweep({
			branchWorkerNames,
			liveNames: new Set(['kody-branch-foo-api']),
			maxPerRun: 10,
		}),
	).toEqual({ sweep: ['kody-branch-foo'], deferred: [], live: [] })
})

test('a D1 name from one live branch can never mask an unrelated orphaned branch of the same name', () => {
	// Regression for the review follow-up on #3563. Two distinct branches:
	// - "foo" is live: bare worker `kody-branch-foo`, own D1 `kody-branch-foo-db`.
	// - "foo-db" is orphaned: its worker is already gone, but its own D1
	//   leftover `kody-branch-foo-db-db` survives (base `kody-branch-foo-db`
	//   after stripping the trailing "-db" suffix).
	// Live "foo"'s D1 name and orphaned "foo-db"'s bare worker name are the
	// exact same string: "kody-branch-foo-db". Discovery (`names`) contains
	// both D1 names, so liveness must come only from the Worker scripts
	// listing (`scriptNames`), never from `names`, or the live D1 string
	// would wrongly mark the orphan as live.
	const names = [
		'kody-branch-foo',
		'kody-branch-foo-db',
		'kody-branch-foo-db-db',
	]
	const scriptNames = ['kody-branch-foo']
	const branchWorkerNames = collectPreviewBranchWorkerNames(names)
	expect(branchWorkerNames).toEqual(['kody-branch-foo', 'kody-branch-foo-db'])

	// The bug: liveness from the combined discovery set hides the orphan.
	expect(
		planBranchPreviewSweep({
			branchWorkerNames,
			liveNames: new Set(names),
			maxPerRun: 10,
		}).sweep,
	).toEqual([])

	// The fix: liveness from Worker scripts only finds it.
	expect(
		planBranchPreviewSweep({
			branchWorkerNames,
			liveNames: new Set(scriptNames),
			maxPerRun: 10,
		}),
	).toEqual({
		sweep: ['kody-branch-foo-db'],
		deferred: [],
		live: ['kody-branch-foo'],
	})
})

test('isPreviewDeployInProgress checks in_progress then queued workflow_dispatch preview.yml runs', async () => {
	const requestedStatuses: Array<string> = []
	const requestedEvents = new Set<string | null>()
	const respond = (hasRun: boolean) =>
		(async (input: RequestInfo | URL) => {
			const url = new URL(String(input))
			requestedStatuses.push(url.searchParams.get('status') ?? '')
			requestedEvents.add(url.searchParams.get('event'))
			return jsonResponse({ total_count: hasRun ? 1 : 0 })
		}) as typeof fetch

	await expect(
		isPreviewDeployInProgress({
			repository: 'kentcdodds/kody',
			githubToken: 'token',
			fetcher: respond(false),
		}),
	).resolves.toBe(false)
	expect(requestedStatuses).toEqual(['in_progress', 'queued'])
	// PR-push preview runs never deploy branch previews, so they must not
	// defer branch sweeping.
	expect([...requestedEvents]).toEqual(['workflow_dispatch'])

	requestedStatuses.length = 0
	await expect(
		isPreviewDeployInProgress({
			repository: 'kentcdodds/kody',
			githubToken: 'token',
			fetcher: respond(true),
		}),
	).resolves.toBe(true)
	// Short-circuits on the first status that already has a run; never checks
	// "queued" once "in_progress" already answered true.
	expect(requestedStatuses).toEqual(['in_progress'])

	await expect(
		isPreviewDeployInProgress({
			repository: 'kentcdodds/kody',
			githubToken: 'token',
			fetcher: (async () => jsonResponse({}, 502)) as typeof fetch,
		}),
	).rejects.toThrow(/502/)
})

test('hasBudgetForAnotherCleanup requires room for a full cleanup before the deadline', () => {
	const deadlineMs = 1_000_000
	expect(
		hasBudgetForAnotherCleanup({
			now: () => 847_000,
			deadlineMs,
			cleanupBudgetMs: 150_000,
		}),
	).toBe(true)
	expect(
		hasBudgetForAnotherCleanup({
			now: () => 851_000,
			deadlineMs,
			cleanupBudgetMs: 150_000,
		}),
	).toBe(false)
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

test('previewBranchSlug matches the preview.yml slug step', () => {
	expect(previewBranchSlug('creds-a1-904c')).toBe('creds-a1-904c')
	expect(previewBranchSlug('cursor/Credentials_List--904c/')).toBe(
		'cursor-credentials-list-904c',
	)
	expect(
		previewBranchSlug('cursor/a-very-long-branch-name-that-overflows'),
	).toBe('cursor-a-very-long-branch-name-t')
	expect(previewBranchSlug('///')).toBe('preview')
})

test('collectBranchPreviewSources records the newest unambiguous branch deploy per preview', () => {
	const run = (
		name: string,
		branch: string,
		updatedAt: string,
		conclusion: string | null = 'success',
		status = 'completed',
	) => ({
		display_title: `Preview ${name}`,
		head_branch: branch,
		status,
		conclusion,
		updated_at: updatedAt,
	})
	const sources = collectBranchPreviewSources([
		run(
			'deploy (branch: creds-a1-904c)',
			'cursor/creds-904c',
			'2026-10-13T19:40:00Z',
		),
		run('cleanup (branch: creds-a1-904c)', 'main', '2026-10-13T18:00:00Z'),
		run('deploy (branch: creds-a1-904c)', 'main', '2026-10-12T00:00:00Z'),
		// Newest run failed on the same branch: its later upload time counts.
		run(
			'deploy (branch: same)',
			'feat/same',
			'2026-10-13T12:00:00Z',
			'failure',
		),
		run('deploy (branch: same)', 'feat/same', '2026-10-13T10:00:00Z'),
		// A failed run from another branch may or may not own the Worker.
		run('deploy (branch: shared)', 'feat/b', '2026-10-13T12:00:00Z', 'failure'),
		run('deploy (branch: shared)', 'feat/a', '2026-10-13T10:00:00Z'),
		// Still running: unknown until it finishes.
		run(
			'deploy (branch: busy)',
			'feat/busy',
			'2026-10-13T12:00:00Z',
			null,
			'in_progress',
		),
		run('deploy (branch: busy)', 'feat/busy', '2026-10-13T10:00:00Z'),
		// Never deployed successfully.
		run(
			'deploy (branch: broken)',
			'feat/broken',
			'2026-10-13T12:00:00Z',
			'failure',
		),
		run('deploy (pr: 12)', 'main', '2026-10-12T00:00:00Z'),
		{
			...run('', 'feature', '2026-10-12T00:00:00Z'),
			display_title: 'feat: some PR title',
		},
	])
	expect([...sources]).toEqual([
		[
			'kody-branch-creds-a1-904c',
			{ branch: 'cursor/creds-904c', deployedAt: '2026-10-13T19:40:00Z' },
		],
		[
			'kody-branch-same',
			{ branch: 'feat/same', deployedAt: '2026-10-13T12:00:00Z' },
		],
	])
})

test('planClosedSourceBranchSweep sweeps only previews whose source PRs all closed after the deploy', () => {
	const deployedAt = '2026-10-13T19:00:00Z'
	const sources = new Map([
		['kody-branch-closed', { branch: 'b/closed', deployedAt }],
		['kody-branch-open', { branch: 'b/open', deployedAt }],
		['kody-branch-reopened', { branch: 'b/reopened', deployedAt }],
		['kody-branch-no-pr', { branch: 'b/no-pr', deployedAt }],
		['kody-branch-from-main', { branch: 'main', deployedAt }],
		['kody-branch-after-close', { branch: 'b/after-close', deployedAt }],
	])
	const closed = (closedAt: string) => ({ state: 'closed' as const, closedAt })
	const pullRequests = new Map([
		['b/closed', [closed('2026-10-13T21:55:00Z')]],
		['b/open', [{ state: 'open' as const, closedAt: null }]],
		[
			'b/reopened',
			[
				closed('2026-10-13T20:00:00Z'),
				{ state: 'open' as const, closedAt: null },
			],
		],
		['b/no-pr', []],
		['main', [closed('2026-10-13T21:00:00Z')]],
		['b/after-close', [closed('2026-10-13T18:00:00Z')]],
	])
	expect(
		planClosedSourceBranchSweep({
			liveBranchWorkerNames: [...sources.keys(), 'kody-branch-unrecorded'],
			sources,
			pullRequests,
			defaultBranch: 'main',
		}),
	).toEqual([{ workerName: 'kody-branch-closed', branch: 'b/closed' }])
})

test('listBranchPullRequests queries by owner:branch across states', async () => {
	const urls: Array<URL> = []
	const pulls = await listBranchPullRequests({
		repository: 'kentcdodds/kody',
		branch: 'cursor/credentials-list-904c',
		githubToken: 'token',
		fetcher: (async (input: RequestInfo | URL) => {
			urls.push(new URL(String(input)))
			return jsonResponse([
				{ state: 'closed', closed_at: '2026-10-13T21:55:29Z' },
				{ state: 'open', closed_at: null },
			])
		}) as typeof fetch,
	})
	expect(urls[0]?.searchParams.get('head')).toBe(
		'kentcdodds:cursor/credentials-list-904c',
	)
	expect(urls[0]?.searchParams.get('state')).toBe('all')
	expect(urls).toHaveLength(1)
	expect(pulls).toEqual([
		{ state: 'closed', closedAt: '2026-10-13T21:55:29Z' },
		{ state: 'open', closedAt: null },
	])
	await expect(
		listBranchPullRequests({
			repository: 'kentcdodds/kody',
			branch: 'x',
			githubToken: 'token',
			fetcher: (async () => jsonResponse({}, 502)) as typeof fetch,
		}),
	).rejects.toThrow(/502/)
})
