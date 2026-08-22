import {
	createPublicCodeRunsWindow,
	parsePublicCodeRunsWindow,
	publicCodeRunsKvKey,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultCodeRunsJsonUrl = 'https://kody.codes/code-runs.json'
export const defaultBundleArtifactsKvTitle = 'kody-bundle-artifacts'
export const defaultSeedDelta = 86_400

export type SeedPublicCodeRunsArgs = {
	previous?: number
	current?: number
	delta: number
	dryRun: boolean
	now?: Date
	codeRunsJsonUrl: string
	kvTitle: string
}

type CloudflareListResponse<T> = {
	success: boolean
	errors?: Array<{ message?: string }>
	result?: Array<T>
	result_info?: { page?: number; total_pages?: number }
}

export function parseSeedPublicCodeRunsArgs(
	argv: Array<string>,
): SeedPublicCodeRunsArgs {
	const args: SeedPublicCodeRunsArgs = {
		delta: defaultSeedDelta,
		dryRun: false,
		codeRunsJsonUrl: defaultCodeRunsJsonUrl,
		kvTitle: defaultBundleArtifactsKvTitle,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index]
		const next = argv[index + 1]
		switch (flag) {
			case '--dry-run':
				args.dryRun = true
				break
			case '--previous':
				args.previous = readNonNegativeIntArg(flag, next)
				index += 1
				break
			case '--current':
				args.current = readNonNegativeIntArg(flag, next)
				index += 1
				break
			case '--delta':
				args.delta = readNonNegativeIntArg(flag, next)
				index += 1
				break
			case '--now':
				args.now = readDateArg(flag, next)
				index += 1
				break
			case '--url':
				if (!next) throw new Error('Missing value for --url')
				args.codeRunsJsonUrl = next
				index += 1
				break
			case '--kv-title':
				if (!next) throw new Error('Missing value for --kv-title')
				args.kvTitle = next
				index += 1
				break
			default:
				throw new Error(`Unknown argument: ${flag}`)
		}
	}
	return args
}

export function resolveSeededCodeRunsCounts(input: {
	liveCurrent: number
	previous?: number
	current?: number
	delta: number
}): { previous: number; current: number } {
	const previous = input.previous ?? input.liveCurrent
	const current = input.current ?? previous + input.delta
	if (!Number.isFinite(previous) || previous < 0) {
		throw new Error('previous must be a non-negative integer')
	}
	if (!Number.isFinite(current) || current < previous) {
		throw new Error('current must be an integer >= previous')
	}
	return {
		previous: Math.floor(previous),
		current: Math.floor(current),
	}
}

export function buildSeededPublicCodeRunsWindow(input: {
	liveCurrent: number
	previous?: number
	current?: number
	delta: number
	now: Date
}): PublicCodeRunsWindow {
	const counts = resolveSeededCodeRunsCounts(input)
	const window = createPublicCodeRunsWindow({
		...counts,
		now: input.now,
	})
	if (!window) {
		throw new Error('Seeded window failed validation')
	}
	return window
}

export async function readLiveCodeRunsCurrent(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<number> {
	const response = await fetchImpl(url)
	if (!response.ok) {
		throw new Error(`Failed to read ${url}: HTTP ${response.status}`)
	}
	const payload = (await response.json()) as { window?: unknown }
	const window = parsePublicCodeRunsWindow(payload.window)
	if (!window) {
		throw new Error(`No valid public code-runs window at ${url}`)
	}
	return window.current
}

export async function findKvNamespaceId(input: {
	accountId: string
	apiToken: string
	title: string
	fetchImpl?: typeof fetch
}): Promise<string> {
	const fetchImpl = input.fetchImpl ?? fetch
	for (let page = 1; page <= 20; page += 1) {
		const url = new URL(
			`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/storage/kv/namespaces`,
		)
		url.searchParams.set('page', String(page))
		url.searchParams.set('per_page', '100')
		const payload = await readCloudflareJson<
			CloudflareListResponse<{ id?: string; title?: string }>
		>(fetchImpl, url, input.apiToken)
		const match = payload.result?.find((entry) => entry.title === input.title)
		if (typeof match?.id === 'string' && match.id.length > 0) {
			return match.id
		}
		const totalPages = payload.result_info?.total_pages ?? page
		if (page >= totalPages) break
	}
	throw new Error(`KV namespace not found: ${input.title}`)
}

export async function putPublicCodeRunsWindow(input: {
	accountId: string
	apiToken: string
	namespaceId: string
	window: PublicCodeRunsWindow
	fetchImpl?: typeof fetch
}): Promise<void> {
	const fetchImpl = input.fetchImpl ?? fetch
	const url = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/storage/kv/namespaces/${input.namespaceId}/values/${encodeURIComponent(publicCodeRunsKvKey)}`
	const payload = await readCloudflareJson<{ success: boolean }>(
		fetchImpl,
		url,
		input.apiToken,
		{
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: JSON.stringify(input.window),
		},
	)
	if (payload.success !== true) {
		throw new Error('Cloudflare KV put did not succeed')
	}
}

async function readCloudflareJson<T>(
	fetchImpl: typeof fetch,
	url: URL | string,
	apiToken: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetchImpl(url, {
		...init,
		headers: {
			Authorization: `Bearer ${apiToken}`,
			...init?.headers,
		},
	})
	const payload = (await response.json()) as T & {
		success?: boolean
		errors?: Array<{ message?: string }>
	}
	if (!response.ok || payload.success === false) {
		const detail = payload.errors?.map((error) => error.message).join('; ')
		throw new Error(
			`Cloudflare API ${response.status}${detail ? `: ${detail}` : ''}`,
		)
	}
	return payload
}

function readNonNegativeIntArg(flag: string, value: string | undefined) {
	if (value === undefined || value.length === 0) {
		throw new Error(`Missing value for ${flag}`)
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
		throw new Error(`${flag} must be a non-negative integer`)
	}
	return parsed
}

function readDateArg(flag: string, value: string | undefined) {
	if (!value) throw new Error(`Missing value for ${flag}`)
	const parsed = new Date(value)
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`${flag} must be an ISO timestamp`)
	}
	return parsed
}

async function main(argv: Array<string>) {
	const args = parseSeedPublicCodeRunsArgs(argv)
	const liveCurrent = await readLiveCodeRunsCurrent(args.codeRunsJsonUrl)
	const window = buildSeededPublicCodeRunsWindow({
		liveCurrent,
		previous: args.previous,
		current: args.current,
		delta: args.delta,
		now: args.now ?? new Date(),
	})
	console.log(JSON.stringify({ liveCurrent, window, dryRun: args.dryRun }))
	if (args.dryRun) return

	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) {
		throw new Error(
			'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required unless --dry-run',
		)
	}
	const namespaceId = await findKvNamespaceId({
		accountId,
		apiToken,
		title: args.kvTitle,
	})
	await putPublicCodeRunsWindow({
		accountId,
		apiToken,
		namespaceId,
		window,
	})
}

if (isExecutedDirectly(import.meta.url)) {
	await main(process.argv.slice(2))
}
