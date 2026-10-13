import { isExecutedDirectly } from '../node-runtime.ts'
import {
	assertPreviewResourceName,
	cleanupPreviewResources,
	previewCleanupBudgetMsDefault,
	previewResourceNamePattern,
} from './preview-resources.ts'
import { cloudflareApiRequest, fail } from './resource-utils.ts'

/**
 * Scheduled sweep for PR previews whose close-time cleanup never ran or
 * failed (#3396). Leftover preview Workers keep their Durable Object
 * namespaces, and the account cap (500) then fails every new preview deploy.
 * `kody-pr-<number>*` names whose pull request is closed are swept this way.
 * Every delete goes through `cleanupPreviewResources`, which applies the
 * preview naming guard (#2024).
 *
 * Branch previews (`kody-branch-<slug>*`) have no pull request to check, so
 * they are swept on worker liveness instead: once the bare `kody-branch-<slug>`
 * script is gone, its D1/KV/R2 leftovers are orphaned and swept the same way
 * (#3563). Liveness is judged ONLY from a `/workers/scripts` listing
 * (`listPreviewCandidateNames`'s own `scriptNames`, or the fresh re-fetch in
 * `main` right before branch processing), never from the broader D1/KV/R2/DO
 * discovery names (`names`): a D1 database can share its exact string with
 * another branch's bare worker name, which would otherwise read as "live"
 * and mask a real orphan of that name (review follow-up on #3563). `names`
 * still includes Durable Object namespaces, D1, KV namespaces, and R2
 * buckets, so a branch whose Worker cleanup already ran but left an
 * independent KV or R2 leftover is still discoverable by that leftover's
 * name.
 *
 * Because a branch deploy (`preview.yml`, `workflow_dispatch` only) creates
 * its D1/KV/R2 resources before it uploads the bare origin Worker, a branch
 * can look orphaned (resources exist, Worker does not) for the several
 * minutes a deploy is still running. Before sweeping ANY branch this run,
 * `isPreviewDeployInProgress` checks whether a `preview.yml` run is currently
 * queued or in progress at all, and skips branch sweeping entirely for this
 * run if so — deliberately coarse (it does not try to match the specific
 * branch, since the workflow's `preview_name` input can be an arbitrary
 * override that the swept resource name cannot be reversed back into), but
 * sufficient given branch previews are a manual, infrequent action compared
 * to the hourly sweep cadence.
 */

const prPreviewNamePattern = /^kody-pr-(\d+)(?:-|$)/
const branchWorkerNamePattern = /^kody-branch-[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Fixed suffixes `buildPreviewResourceNames`/`listPreviewWorkerNames`
 * (`preview-resources.ts`) append to a preview worker's base name, longest
 * first so "-audit-db"/"-jobs-db" strip before the shorter "-db". A branch
 * slug that happens to end in one of these words (e.g. a branch literally
 * named `.../my-runtime`) is misread as a suffixed resource of a shorter
 * base; accepted as a known edge case of free-form slugs, same as
 * `buildPreviewResourceNames`'s own truncation note.
 *
 * Preview queues are excluded: `previewQueueName` (preview-queue-plan.ts) can
 * hash and truncate the suffix, so it cannot be reversed from the name
 * alone. A queue-only leftover with no other trace is not detected by this
 * sweep; #3563 asks for D1/KV/R2, not queues. Mock-server workers
 * (`-mock-<service>`) are excluded for the same reason (dynamic suffix).
 */
const previewDerivedNameSuffixes = [
	'-audit-db',
	'-jobs-db',
	'-bundle-artifacts-kv',
	'-community-assets',
	'-repo-session-blobs',
	'-operator-backups',
	'-email-blobs',
	'-highlight',
	'-platform',
	'-runtime',
	'-vectors',
	'-oauth-kv',
	'-db',
	'-api',
	'-jobs',
].sort((left, right) => right.length - left.length)

export const previewSweepMaxPerRunDefault = 10

export type PullRequestState = 'open' | 'closed' | 'unknown'

export function previewPullRequestNumber(name: string): number | null {
	if (!previewResourceNamePattern.test(name)) return null
	const match = prPreviewNamePattern.exec(name)
	if (!match?.[1]) return null
	const number = Number.parseInt(match[1], 10)
	return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function collectPreviewPullRequestNumbers(
	names: Iterable<string>,
): Array<number> {
	const numbers = new Set<number>()
	for (const name of names) {
		const number = previewPullRequestNumber(name)
		if (number !== null) numbers.add(number)
	}
	return [...numbers].sort((left, right) => left - right)
}

/**
 * Branch previews (`kody-branch-<slug>`) have no pull request to check, so
 * they are swept on worker liveness instead: the bare `kody-branch-<slug>`
 * script is the one `listPreviewWorkerNames` deploys as the public entry
 * (what `.../health` answers), so its absence from the current
 * `/workers/scripts` listing means the preview is gone and only its D1/KV/R2
 * leftovers remain (#3563).
 */
export function previewBranchWorkerName(name: string): string | null {
	if (!previewResourceNamePattern.test(name)) return null
	if (!name.startsWith('kody-branch-')) return null
	const suffix = previewDerivedNameSuffixes.find((candidate) =>
		name.endsWith(candidate),
	)
	const base = suffix ? name.slice(0, -suffix.length) : name
	return branchWorkerNamePattern.test(base) ? base : null
}

export function collectPreviewBranchWorkerNames(
	names: Iterable<string>,
): Array<string> {
	const workerNames = new Set<string>()
	for (const name of names) {
		const workerName = previewBranchWorkerName(name)
		if (workerName !== null) workerNames.add(workerName)
	}
	return [...workerNames].sort()
}

export function planPreviewSweep(input: {
	pullRequestNumbers: ReadonlyArray<number>
	states: ReadonlyMap<number, PullRequestState>
	maxPerRun: number
}) {
	const closed = input.pullRequestNumbers.filter(
		(number) => input.states.get(number) === 'closed',
	)
	return {
		sweep: closed.slice(0, Math.max(0, input.maxPerRun)),
		deferred: closed.slice(Math.max(0, input.maxPerRun)),
		open: input.pullRequestNumbers.filter(
			(number) => input.states.get(number) === 'open',
		),
		unknown: input.pullRequestNumbers.filter(
			(number) => (input.states.get(number) ?? 'unknown') === 'unknown',
		),
	}
}

export function planBranchPreviewSweep(input: {
	branchWorkerNames: ReadonlyArray<string>
	liveNames: ReadonlySet<string>
	maxPerRun: number
}) {
	const orphaned = input.branchWorkerNames.filter(
		(name) => !input.liveNames.has(name),
	)
	return {
		sweep: orphaned.slice(0, Math.max(0, input.maxPerRun)),
		deferred: orphaned.slice(Math.max(0, input.maxPerRun)),
		live: input.branchWorkerNames.filter((name) => input.liveNames.has(name)),
	}
}

type CloudflareClient = {
	accountId: string
	apiToken: string
	fetcher?: typeof fetch
}

/**
 * The Durable Object namespace listing has answered both `[...]` and
 * `{ namespaces: [...] }` (see `origin-production-deploy-state.ts`).
 */
function readListedItems<T>(result: unknown, pathname: string): Array<T> {
	if (result === undefined || result === null) return []
	if (Array.isArray(result)) return result as Array<T>
	const namespaces = (result as { namespaces?: unknown }).namespaces
	if (Array.isArray(namespaces)) return namespaces as Array<T>
	throw new Error(`Cloudflare listing ${pathname} returned a malformed result.`)
}

async function listPaged<T>(
	client: CloudflareClient,
	pathname: string,
	perPage: number,
) {
	const items: Array<T> = []
	for (let page = 1; page <= 100; page += 1) {
		const separator = pathname.includes('?') ? '&' : '?'
		const payload = await cloudflareApiRequest<unknown>({
			...client,
			pathname: `${pathname}${separator}page=${String(page)}&per_page=${String(perPage)}`,
		})
		const result = readListedItems<T>(payload.result, pathname)
		items.push(...result)
		const totalPages = payload.result_info?.total_pages
		const lastPage =
			typeof totalPages === 'number'
				? page >= totalPages
				: result.length < perPage
		if (lastPage) break
	}
	return items
}

/**
 * Cursor-paginated, same shape as `/r2/buckets/<name>/objects` elsewhere in
 * this file's sibling module: R2's bucket listing wraps results in
 * `{ buckets: [...] }` and pages by `cursor`, not `page`, so it does not fit
 * `listPaged`.
 */
async function listR2BucketNames(
	client: CloudflareClient,
): Promise<Array<string>> {
	const names: Array<string> = []
	let cursor: string | undefined
	for (let page = 0; page < 100; page += 1) {
		const search = new URLSearchParams({ per_page: '1000' })
		if (cursor) search.set('cursor', cursor)
		const payload = await cloudflareApiRequest<{
			buckets?: Array<{ name?: string }>
		}>({
			...client,
			pathname: `/r2/buckets?${search.toString()}`,
		})
		const buckets = payload.result?.buckets ?? []
		names.push(
			...buckets
				.map((bucket) => bucket.name)
				.filter((name): name is string => typeof name === 'string'),
		)
		const nextCursor = payload.result_info?.cursor
		if (!nextCursor || nextCursor === cursor) break
		cursor = nextCursor
	}
	return names
}

/**
 * Worker scripts (`scriptNames`, the only source of truth for liveness), plus
 * the broader discovery set `names`: Durable Object namespaces (by owning
 * script), D1 databases, KV namespaces, and R2 buckets. A preview whose
 * Workers are gone but whose D1, KV, or R2 cleanup failed is still found
 * through its leftover resource names (#3563 and review follow-up). The
 * scripts listing is one unpaged response; every other kind pages.
 */
export async function listPreviewCandidateNames(client: CloudflareClient) {
	const scripts = await cloudflareApiRequest<Array<{ id?: string }>>({
		...client,
		pathname: '/workers/scripts',
	})
	const scriptNames = (scripts.result ?? [])
		.map((script) => script.id)
		.filter((name): name is string => typeof name === 'string')
	const namespaces = await listPaged<{ script?: string; name?: string }>(
		client,
		'/workers/durable_objects/namespaces',
		100,
	)
	const databases = await listPaged<{ name?: string }>(
		client,
		'/d1/database',
		100,
	)
	const kvNamespaces = await listPaged<{ title?: string }>(
		client,
		'/storage/kv/namespaces',
		100,
	)
	const r2BucketNames = await listR2BucketNames(client)
	const names = [
		...scriptNames,
		...namespaces.flatMap((namespace) => [namespace.script, namespace.name]),
		...databases.map((database) => database.name),
		...kvNamespaces.map((namespace) => namespace.title),
		...r2BucketNames,
	].filter((name): name is string => typeof name === 'string')
	return { names, scriptNames }
}

/**
 * Whether a `preview.yml` run is currently queued or in progress, for ANY
 * branch. Deliberately account-wide rather than matched to one branch: the
 * workflow's `preview_name` input can override the slug with an arbitrary
 * string, so a swept resource name cannot be reversed back into the exact
 * ref or input that produced it. Branch-preview deploys are a manual,
 * infrequent `workflow_dispatch` action, so pausing all branch sweeping while
 * any one is running is a deliberate, cheap trade against the alternative:
 * deleting resources out from under a deploy that provisioned its D1/KV/R2
 * before uploading the bare origin Worker (review follow-up on #3563).
 */
export async function isPreviewDeployInProgress(input: {
	repository: string
	githubToken: string
	fetcher?: typeof fetch
}): Promise<boolean> {
	const fetcher = input.fetcher ?? fetch
	for (const status of ['in_progress', 'queued']) {
		const response = await fetcher(
			`https://api.github.com/repos/${input.repository}/actions/workflows/preview.yml/runs?status=${status}&per_page=1`,
			{
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${input.githubToken}`,
					'X-GitHub-Api-Version': '2022-11-28',
				},
				signal: AbortSignal.timeout(15_000),
			},
		)
		if (!response.ok) {
			throw new Error(
				`GitHub API GET actions/workflows/preview.yml/runs?status=${status} failed (${String(response.status)}).`,
			)
		}
		const json = (await response.json()) as { total_count?: unknown }
		if (typeof json.total_count === 'number' && json.total_count > 0) {
			return true
		}
	}
	return false
}

/**
 * The scheduled job has a 40-minute timeout; this leaves room for
 * `npm ci`, the account-wide listing calls, and GitHub API reads, while
 * still budgeting for at least one more `previewCleanupBudgetMsDefault`-sized
 * cleanup before starting it. Both the PR and branch loops share this one
 * deadline, since a run that spends its whole budget on PR cleanups should
 * still defer branch cleanups cleanly rather than exceed the job timeout
 * (review follow-up on #3563: `maxPerRun` alone does not bound wall-clock
 * time once branches are swept in the same run as PRs).
 */
export const previewSweepWallClockBudgetMsDefault = 30 * 60_000

export function hasBudgetForAnotherCleanup(input: {
	now: () => number
	deadlineMs: number
	cleanupBudgetMs: number
}): boolean {
	return input.now() + input.cleanupBudgetMs <= input.deadlineMs
}

export async function readPullRequestState(input: {
	repository: string
	number: number
	githubToken: string
	fetcher?: typeof fetch
}): Promise<PullRequestState> {
	const response = await (input.fetcher ?? fetch)(
		`https://api.github.com/repos/${input.repository}/pulls/${String(input.number)}`,
		{
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${input.githubToken}`,
				'X-GitHub-Api-Version': '2022-11-28',
			},
			signal: AbortSignal.timeout(15_000),
		},
	)
	if (response.status === 404) {
		await response.body?.cancel()
		return 'unknown'
	}
	if (!response.ok) {
		throw new Error(
			`GitHub API GET pulls/${String(input.number)} failed (${String(response.status)}).`,
		)
	}
	const json = (await response.json()) as { state?: unknown }
	if (json.state === 'open' || json.state === 'closed') return json.state
	return 'unknown'
}

function parseArgs(argv: ReadonlyArray<string>) {
	let maxPerRun = previewSweepMaxPerRunDefault
	let dryRun = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--dry-run') {
			dryRun = true
		} else if (arg === '--max') {
			const value = Number.parseInt(argv[index + 1] ?? '', 10)
			if (!Number.isSafeInteger(value) || value < 0) {
				fail('--max requires a non-negative integer.')
			}
			maxPerRun = value
			index += 1
		} else if (arg) {
			fail(
				`Unknown argument: ${arg}. Usage: node tools/ci/preview-sweep.ts [--max <n>] [--dry-run]`,
			)
		}
	}
	return { maxPerRun, dryRun }
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) fail(`Missing ${name} for the preview sweep.`)
	return value
}

async function main() {
	const { maxPerRun, dryRun } = parseArgs(process.argv.slice(2))
	const client = {
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
	}
	const repository = requireEnv('GITHUB_REPOSITORY')
	const githubToken = requireEnv('GITHUB_TOKEN')
	const readState = (number: number) =>
		readPullRequestState({ repository, number, githubToken })
	const now = Date.now
	const deadlineMs = now() + previewSweepWallClockBudgetMsDefault
	const hasBudget = () =>
		hasBudgetForAnotherCleanup({
			now,
			deadlineMs,
			cleanupBudgetMs: previewCleanupBudgetMsDefault,
		})

	const { names } = await listPreviewCandidateNames(client)
	const pullRequestNumbers = collectPreviewPullRequestNumbers(names)
	const states = new Map<number, PullRequestState>()
	for (const number of pullRequestNumbers) {
		states.set(number, await readState(number))
	}
	const plan = planPreviewSweep({ pullRequestNumbers, states, maxPerRun })
	console.log(
		[
			`Preview sweep: ${String(pullRequestNumbers.length)} PR preview(s) on the account.`,
			`  open: ${plan.open.join(', ') || 'none'}`,
			`  closed, sweeping now: ${plan.sweep.join(', ') || 'none'}`,
			`  closed, next run: ${plan.deferred.join(', ') || 'none'}`,
			`  no matching PR (left alone): ${plan.unknown.join(', ') || 'none'}`,
		].join('\n'),
	)

	const failed: Array<number> = []
	for (const [index, number] of plan.sweep.entries()) {
		if (!hasBudget()) {
			const remaining = plan.sweep.slice(index)
			console.log(
				`Preview sweep: wall-clock budget used, deferring ${String(remaining.length)} PR cleanup(s) to the next run: ${remaining.join(', ')}.`,
			)
			break
		}
		// A PR reopened since the listing redeploys its preview; leave it.
		if ((await readState(number)) !== 'closed') {
			console.log(`Skipping kody-pr-${String(number)}: PR is no longer closed.`)
			continue
		}
		const workerName = `kody-pr-${String(number)}`
		assertPreviewResourceName(workerName, 'worker')
		console.log(`Cleaning up ${workerName}${dryRun ? ' (dry run)' : ''}.`)
		try {
			await cleanupPreviewResources({ workerName, dryRun, ...client })
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error))
			failed.push(number)
		}
	}

	const branchWorkerNames = collectPreviewBranchWorkerNames(names)
	const failedBranches: Array<string> = []
	const deployInProgress = branchWorkerNames.length
		? await isPreviewDeployInProgress({ repository, githubToken })
		: false
	if (deployInProgress) {
		console.log(
			'Branch preview sweep: a preview.yml run is queued or in progress; deferring all branch-preview sweeping to the next run so an in-flight deploy cannot be swept mid-provision.',
		)
	} else {
		// Re-fetch liveness right before deleting anything, rather than reusing
		// the listing taken before every PR cleanup above: narrows the window
		// between "this branch looked orphaned" and the actual delete.
		const freshScripts = await cloudflareApiRequest<Array<{ id?: string }>>({
			...client,
			pathname: '/workers/scripts',
		})
		const liveNames = new Set(
			(freshScripts.result ?? [])
				.map((script) => script.id)
				.filter((id): id is string => typeof id === 'string'),
		)
		const branchPlan = planBranchPreviewSweep({
			branchWorkerNames,
			liveNames,
			maxPerRun,
		})
		console.log(
			[
				`Branch preview sweep: ${String(branchWorkerNames.length)} branch preview(s) on the account.`,
				`  live: ${branchPlan.live.join(', ') || 'none'}`,
				`  orphaned, sweeping now: ${branchPlan.sweep.join(', ') || 'none'}`,
				`  orphaned, next run: ${branchPlan.deferred.join(', ') || 'none'}`,
			].join('\n'),
		)

		for (const [index, workerName] of branchPlan.sweep.entries()) {
			if (!hasBudget()) {
				const remaining = branchPlan.sweep.slice(index)
				console.log(
					`Preview sweep: wall-clock budget used, deferring ${String(remaining.length)} branch cleanup(s) to the next run: ${remaining.join(', ')}.`,
				)
				break
			}
			assertPreviewResourceName(workerName, 'worker')
			console.log(`Cleaning up ${workerName}${dryRun ? ' (dry run)' : ''}.`)
			try {
				await cleanupPreviewResources({ workerName, dryRun, ...client })
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error))
				failedBranches.push(workerName)
			}
		}
	}

	if (failed.length > 0 || failedBranches.length > 0) {
		const failedNames = [
			...failed.map((number) => `kody-pr-${String(number)}`),
			...failedBranches,
		]
		fail(
			`Preview sweep could not fully clean up: ${failedNames.join(', ')}. The next scheduled run retries them.`,
		)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	try {
		await main()
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}
}
