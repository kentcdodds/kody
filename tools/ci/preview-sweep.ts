import { isExecutedDirectly } from '../node-runtime.ts'
import {
	assertPreviewResourceName,
	cleanupPreviewResources,
	previewResourceNamePattern,
} from './preview-resources.ts'
import { cloudflareApiRequest, fail } from './resource-utils.ts'

/**
 * Scheduled sweep for PR previews whose close-time cleanup never ran or
 * failed (#3396). Leftover preview Workers keep their Durable Object
 * namespaces, and the account cap (500) then fails every new preview deploy.
 * Only `kody-pr-<number>*` names whose pull request is closed are swept, and
 * every delete goes through `cleanupPreviewResources`, which applies the
 * preview naming guard (#2024). Branch previews (`kody-branch-*`) have no PR
 * to check and are left alone.
 */

const prPreviewNamePattern = /^kody-pr-(\d+)(?:-|$)/

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

type CloudflareClient = {
	accountId: string
	apiToken: string
	fetcher?: typeof fetch
}

async function listPaged<T>(
	client: CloudflareClient,
	pathname: string,
	perPage: number,
) {
	const items: Array<T> = []
	for (let page = 1; page <= 100; page += 1) {
		const separator = pathname.includes('?') ? '&' : '?'
		const payload = await cloudflareApiRequest<Array<T>>({
			...client,
			pathname: `${pathname}${separator}page=${String(page)}&per_page=${String(perPage)}`,
		})
		const result = payload.result ?? []
		items.push(...result)
		const totalPages = payload.result_info?.total_pages
		if (
			result.length < perPage ||
			(totalPages !== undefined && page >= totalPages)
		) {
			break
		}
	}
	return items
}

/**
 * Worker scripts, Durable Object namespaces (by owning script), and D1
 * databases. A preview whose Workers are gone but whose D1 cleanup failed is
 * still found through its `kody-pr-<n>-db` names.
 */
export async function listPreviewCandidateNames(client: CloudflareClient) {
	const scripts = await cloudflareApiRequest<Array<{ id?: string }>>({
		...client,
		pathname: '/workers/scripts',
	})
	const namespaces = await listPaged<{ script?: string; name?: string }>(
		client,
		'/workers/durable_objects/namespaces',
		1000,
	)
	const databases = await listPaged<{ name?: string }>(
		client,
		'/d1/database',
		100,
	)
	const names = [
		...(scripts.result ?? []).map((script) => script.id),
		...namespaces.flatMap((namespace) => [namespace.script, namespace.name]),
		...databases.map((database) => database.name),
	]
	return names.filter((name): name is string => typeof name === 'string')
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

	const pullRequestNumbers = collectPreviewPullRequestNumbers(
		await listPreviewCandidateNames(client),
	)
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
	for (const number of plan.sweep) {
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
	if (failed.length > 0) {
		fail(
			`Preview sweep could not fully clean up: ${failed.map((number) => `kody-pr-${String(number)}`).join(', ')}. The next scheduled run retries them.`,
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
