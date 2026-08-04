import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveLocalBinary } from '../node-runtime.ts'

type WranglerEnvName = 'preview' | 'production'

type WranglerMigration = {
	tag: string
	deleted_classes?: Array<string>
	new_sqlite_classes?: Array<string>
	renamed_classes?: Array<{
		from: string
		to: string
	}>
}

type D1DatabaseListEntry = {
	uuid: string
	name: string
}

type KvNamespaceListEntry = {
	id: string
	title: string
}

export type CloudflareApiEnvelope<T> = {
	success?: boolean
	result?: T
	errors?: Array<{ code?: number | string; message?: string }>
	result_info?: { total_pages?: number; cursor?: string }
}

type CloudflareQueue = {
	queue_id: string
	queue_name: string
}

type CloudflareEventSubscription = {
	id: string
	name: string
	enabled: boolean
	events: Array<string>
	source: Record<string, unknown>
	destination: {
		type: string
		queue_id: string
	}
}

export const emailSendingEventTypes = [
	'message.delivered',
	'message.deferred',
	'message.bounced',
	'message.failed',
	'message.rejected',
	'message.complained',
] as const

export const artifactsAccountEventTypes = [
	'repo.created',
	'repo.deleted',
] as const

export function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function renderArg(value: string) {
	if (!value) return '""'
	if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value
	return JSON.stringify(value)
}

export function runWrangler(
	args: Array<string>,
	options?: { input?: string; quiet?: boolean },
) {
	const wranglerBin = resolveLocalBinary('wrangler')
	const result = spawnSync(wranglerBin, args, {
		encoding: 'utf8',
		stdio: 'pipe',
		input: options?.input,
		env: process.env,
	})

	const status = result.status ?? 1
	const stdout = result.stdout ?? ''
	const stderr = result.stderr ?? ''

	if (!options?.quiet) {
		const rendered = args.map(renderArg).join(' ')
		console.error(`wrangler: ${wranglerBin} ${rendered}`)
	}

	if (status !== 0) {
		if (options?.quiet) {
			const rendered = args.map(renderArg).join(' ')
			console.error(`wrangler (failed): ${wranglerBin} ${rendered}`)
		}
		const output = `${stdout}${stderr}`.trim()
		if (output) {
			console.error(output)
		}
	}

	return { status, stdout, stderr }
}

export function truncateWithSuffix(
	base: string,
	suffix: string,
	maxLen: number,
) {
	if (base.length + suffix.length <= maxLen) {
		return `${base}${suffix}`
	}
	const cut = Math.max(1, maxLen - suffix.length)
	const trimmed = base.slice(0, cut).replace(/-+$/g, '')
	return `${trimmed}${suffix}`
}

export function listD1Databases(): Array<D1DatabaseListEntry> {
	const result = runWrangler(['d1', 'list', '--json'], { quiet: true })
	if (result.status !== 0) {
		fail('Failed to list D1 databases (wrangler d1 list --json).')
	}
	try {
		return JSON.parse(result.stdout) as Array<D1DatabaseListEntry>
	} catch {
		fail('Could not parse JSON output from wrangler d1 list --json.')
	}
}

export function listKvNamespaces(): Array<KvNamespaceListEntry> {
	const result = runWrangler(['kv', 'namespace', 'list'], { quiet: true })
	if (result.status !== 0) {
		fail('Failed to list KV namespaces (wrangler kv namespace list).')
	}
	try {
		return JSON.parse(result.stdout) as Array<KvNamespaceListEntry>
	} catch {
		fail('Failed to parse JSON output from wrangler kv namespace list.')
	}
}

export function isWranglerNotFoundOutput(output: string) {
	const lower = output.toLowerCase()
	return (
		lower.includes('not found') ||
		lower.includes('no such') ||
		lower.includes('does not exist')
	)
}

export function deleteWorkerScript({
	name,
	dryRun,
}: {
	name: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] delete Worker script: ${name}`)
		return
	}

	// Delete by script name only. Passing --config/--env makes Wrangler resolve
	// bindings from wrangler.jsonc (including KV namespaces without ids) and
	// can fail even when the token can delete the Worker and preview resources.
	const result = runWrangler(['delete', name, '--force'], { quiet: true })
	const output = `${result.stdout}${result.stderr}`.trim()

	if (result.status === 0) {
		if (output) {
			console.error(output)
		}
		console.error(`Deleted Worker script: ${name}`)
		return
	}

	if (isWranglerNotFoundOutput(output)) {
		console.error(`Worker script already deleted: ${name}`)
		return
	}

	if (output) {
		console.error(output)
	}
	fail(`Failed to delete Worker script: ${name}`)
}

const ansiEscape = String.fromCharCode(27)

/**
 * `wrangler r2 bucket list` has no JSON output; it prints labelled-value
 * blocks (`name: <bucket>` / `creation_date: ...`). Parse the bucket
 * names out of that listing. Piped wrangler output is normally
 * color-free, but ANSI sequences are stripped defensively.
 */
export function parseR2BucketListOutput(output: string): Array<string> {
	const names: Array<string> = []
	for (const line of output.split('\n')) {
		const plain = line
			.split(ansiEscape)
			.map((part, index) =>
				index === 0 ? part : part.replace(/^\[[0-9;]*m/, ''),
			)
			.join('')
		const match = /^name:\s*(\S+)\s*$/.exec(plain.trim())
		if (match?.[1]) names.push(match[1])
	}
	return names
}

export function listR2BucketNames(): Array<string> {
	const result = runWrangler(['r2', 'bucket', 'list'], { quiet: true })
	if (result.status !== 0) {
		fail('Failed to list R2 buckets (wrangler r2 bucket list).')
	}
	return parseR2BucketListOutput(result.stdout)
}

export function ensureR2Bucket({
	name,
	dryRun,
}: {
	name: string
	dryRun: boolean
}): { name: string } {
	if (dryRun) {
		console.error(`[dry-run] ensure R2 bucket: ${name}`)
		return { name }
	}

	if (listR2BucketNames().includes(name)) {
		console.error(`R2 bucket exists: ${name}`)
		return { name }
	}

	const createResult = runWrangler(['r2', 'bucket', 'create', name], {
		quiet: true,
	})
	if (createResult.status !== 0) {
		fail(`Failed to create R2 bucket: ${name}`)
	}

	if (!listR2BucketNames().includes(name)) {
		fail(`Created R2 bucket "${name}" but could not find it via list.`)
	}
	console.error(`Created R2 bucket: ${name}`)
	return { name }
}

export function deleteR2Bucket({
	name,
	dryRun,
}: {
	name: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] delete R2 bucket: ${name}`)
		return
	}

	if (!listR2BucketNames().includes(name)) {
		console.error(`R2 bucket already deleted: ${name}`)
		return
	}

	const result = runWrangler(['r2', 'bucket', 'delete', name], { quiet: true })
	if (result.status !== 0) {
		// R2 refuses to delete non-empty buckets and wrangler has no purge
		// command; a leftover preview bucket is preferable to a failed
		// cleanup run, so warn instead of failing the workflow.
		console.error(
			`Warning: failed to delete R2 bucket ${name} (it may not be empty); it must be cleaned up manually.`,
		)
		return
	}
	console.error(`Deleted R2 bucket: ${name}`)
}

export async function cloudflareApiRequest<T>(input: {
	accountId: string
	apiToken: string
	pathname: string
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
	body?: Record<string, unknown>
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	const baseUrl = input.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4'
	const url = `${baseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(input.accountId)}${input.pathname}`
	const abortController = new AbortController()
	const timeout = setTimeout(() => abortController.abort(), 30_000)
	let response: Response
	try {
		response = await (input.fetcher ?? fetch)(url, {
			method: input.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${input.apiToken}`,
				Accept: 'application/json',
				...(input.body ? { 'Content-Type': 'application/json' } : {}),
			},
			...(input.body ? { body: JSON.stringify(input.body) } : {}),
			signal: abortController.signal,
		})
	} finally {
		clearTimeout(timeout)
	}
	const payload = (await response.json()) as CloudflareApiEnvelope<T>
	if (
		!response.ok ||
		payload.success !== true ||
		payload.result === undefined
	) {
		const error = payload.errors?.[0]
		throw new Error(
			`Cloudflare API request failed (${response.status}): ${error?.message ?? error?.code ?? input.pathname}`,
		)
	}
	return payload
}

async function listCloudflareQueues(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	const queues: Array<CloudflareQueue> = []
	let page = 1
	let totalPages = 1
	do {
		const payload = await cloudflareApiRequest<Array<CloudflareQueue>>({
			...input,
			pathname: `/queues?page=${page}&per_page=100`,
		})
		queues.push(...(payload.result ?? []))
		totalPages = Math.max(1, payload.result_info?.total_pages ?? 1)
		page += 1
	} while (page <= totalPages)
	return queues
}

export async function ensureCloudflareQueue(input: {
	accountId: string
	apiToken: string
	name: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	if (input.dryRun) {
		console.error(`[dry-run] ensure Queue: ${input.name}`)
		return { id: `dry-run-${input.name}`, name: input.name }
	}
	const existing = (await listCloudflareQueues(input)).find(
		(queue) => queue.queue_name === input.name,
	)
	if (existing) {
		console.error(`Queue exists: ${existing.queue_name} (${existing.queue_id})`)
		return { id: existing.queue_id, name: existing.queue_name }
	}
	const payload = await cloudflareApiRequest<CloudflareQueue>({
		...input,
		pathname: '/queues',
		method: 'POST',
		body: { queue_name: input.name },
	})
	if (!payload.result?.queue_id || !payload.result.queue_name) {
		throw new Error(`Cloudflare created Queue without an id: ${input.name}`)
	}
	console.error(
		`Created Queue: ${payload.result.queue_name} (${payload.result.queue_id})`,
	)
	return { id: payload.result.queue_id, name: payload.result.queue_name }
}

async function listCloudflareEventSubscriptions(input: {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	const subscriptions: Array<CloudflareEventSubscription> = []
	let page = 1
	let totalPages = 1
	do {
		const payload = await cloudflareApiRequest<
			Array<CloudflareEventSubscription>
		>({
			...input,
			pathname: `/event_subscriptions/subscriptions?page=${page}&per_page=100`,
		})
		subscriptions.push(...(payload.result ?? []))
		totalPages = Math.max(1, payload.result_info?.total_pages ?? 1)
		page += 1
	} while (page <= totalPages)
	return subscriptions
}

function sameStringSet(
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
) {
	return (
		left.length === right.length &&
		new Set(left).size === new Set(right).size &&
		left.every((value) => right.includes(value))
	)
}

export async function ensureEmailSendingEventSubscription(input: {
	accountId: string
	apiToken: string
	name: string
	queueId: string
	domain: string
	zoneId: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	if (input.dryRun) {
		console.error(
			`[dry-run] ensure Email Sending event subscription: ${input.name} (${input.domain})`,
		)
		return { id: `dry-run-${input.name}`, name: input.name }
	}
	const subscriptions = await listCloudflareEventSubscriptions(input)
	const existing = subscriptions.find(
		(subscription) => subscription.name === input.name,
	)
	const events = [...emailSendingEventTypes]
	const sourceIsCurrent =
		existing?.source['type'] === 'email.sending' &&
		existing.source['domain'] === input.domain &&
		existing.source['zone_id'] === input.zoneId
	const isCurrent =
		existing?.enabled === true &&
		existing.destination.type === 'queues.queue' &&
		existing.destination.queue_id === input.queueId &&
		sourceIsCurrent &&
		sameStringSet(existing.events, events)
	if (existing && isCurrent) {
		console.error(`Email event subscription exists: ${existing.name}`)
		return { id: existing.id, name: existing.name }
	}
	if (existing) {
		const pathname = `/event_subscriptions/subscriptions/${encodeURIComponent(existing.id)}`
		if (sourceIsCurrent) {
			const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
				...input,
				pathname,
				method: 'PATCH',
				body: {
					name: input.name,
					enabled: true,
					destination: {
						type: 'queues.queue',
						queue_id: input.queueId,
					},
					events,
				},
			})
			console.error(`Updated Email event subscription: ${existing.name}`)
			return {
				id: payload.result?.id ?? existing.id,
				name: payload.result?.name ?? existing.name,
			}
		}
		await cloudflareApiRequest<CloudflareEventSubscription>({
			...input,
			pathname,
			method: 'DELETE',
		})
		console.error(
			`Deleted Email event subscription with stale source: ${existing.name}`,
		)
	}
	const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
		...input,
		pathname: '/event_subscriptions/subscriptions',
		method: 'POST',
		body: {
			name: input.name,
			enabled: true,
			source: {
				type: 'email.sending',
				domain: input.domain,
				zone_id: input.zoneId,
			},
			destination: {
				type: 'queues.queue',
				queue_id: input.queueId,
			},
			events,
		},
	})
	if (!payload.result?.id || !payload.result.name) {
		throw new Error(
			`Cloudflare created Email event subscription without an id: ${input.name}`,
		)
	}
	console.error(`Created Email event subscription: ${payload.result.name}`)
	return { id: payload.result.id, name: payload.result.name }
}

export async function ensureArtifactsAccountEventSubscription(input: {
	accountId: string
	apiToken: string
	name: string
	queueId: string
	dryRun: boolean
	apiBaseUrl?: string
	fetcher?: typeof fetch
}) {
	if (input.dryRun) {
		console.error(
			`[dry-run] ensure Artifacts account event subscription: ${input.name}`,
		)
		return { id: `dry-run-${input.name}`, name: input.name }
	}
	const subscriptions = await listCloudflareEventSubscriptions(input)
	const existing = subscriptions.find(
		(subscription) => subscription.name === input.name,
	)
	const events = [...artifactsAccountEventTypes]
	const sourceIsCurrent = existing?.source['type'] === 'artifacts'
	const isCurrent =
		existing?.enabled === true &&
		existing.destination.type === 'queues.queue' &&
		existing.destination.queue_id === input.queueId &&
		sourceIsCurrent &&
		sameStringSet(existing.events, events)
	if (existing && isCurrent) {
		console.error(`Artifacts event subscription exists: ${existing.name}`)
		return { id: existing.id, name: existing.name }
	}
	if (existing) {
		const pathname = `/event_subscriptions/subscriptions/${encodeURIComponent(existing.id)}`
		if (sourceIsCurrent) {
			const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
				...input,
				pathname,
				method: 'PATCH',
				body: {
					name: input.name,
					enabled: true,
					destination: {
						type: 'queues.queue',
						queue_id: input.queueId,
					},
					events,
				},
			})
			console.error(`Updated Artifacts event subscription: ${existing.name}`)
			return {
				id: payload.result?.id ?? existing.id,
				name: payload.result?.name ?? existing.name,
			}
		}
		await cloudflareApiRequest<CloudflareEventSubscription>({
			...input,
			pathname,
			method: 'DELETE',
		})
		console.error(
			`Deleted Artifacts event subscription with stale source: ${existing.name}`,
		)
	}
	const payload = await cloudflareApiRequest<CloudflareEventSubscription>({
		...input,
		pathname: '/event_subscriptions/subscriptions',
		method: 'POST',
		body: {
			name: input.name,
			enabled: true,
			source: {
				type: 'artifacts',
			},
			destination: {
				type: 'queues.queue',
				queue_id: input.queueId,
			},
			events,
		},
	})
	if (!payload.result?.id || !payload.result.name) {
		throw new Error(
			`Cloudflare created Artifacts event subscription without an id: ${input.name}`,
		)
	}
	console.error(`Created Artifacts event subscription: ${payload.result.name}`)
	return { id: payload.result.id, name: payload.result.name }
}

function stripJsonc(source: string) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let isEscaped = false
	let inLineComment = false
	let inBlockComment = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''
		const next = source[index + 1] ?? ''

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false
				output += char
			}
			continue
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === '/' && next === '/') {
			inLineComment = true
			index += 1
			continue
		}

		if (char === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		output += char
	}

	return output
}

function stripTrailingCommas(source: string) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let isEscaped = false

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? ''

		if (inString) {
			output += char
			if (isEscaped) {
				isEscaped = false
				continue
			}
			if (char === '\\') {
				isEscaped = true
				continue
			}
			if (char === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (char === '"' || char === "'") {
			inString = true
			stringQuote = char
			output += char
			continue
		}

		if (char === ',') {
			let lookahead = index + 1
			while (lookahead < source.length) {
				const next = source[lookahead] ?? ''
				if (next === ' ' || next === '\t' || next === '\n' || next === '\r') {
					lookahead += 1
					continue
				}
				if (next === '}' || next === ']') {
					// Skip comma before a closing token, preserve whitespace.
					break
				}
				break
			}
			const nextNonWhitespace = source[lookahead] ?? ''
			if (nextNonWhitespace === '}' || nextNonWhitespace === ']') {
				continue
			}
		}

		output += char
	}

	return output
}

export function parseJsonc<T>(source: string): T {
	const withoutBom = source.replace(/^\uFEFF/, '')
	const noComments = stripJsonc(withoutBom)
	const json = stripTrailingCommas(noComments)
	return JSON.parse(json) as T
}

function getMigrationTagVersion(tag: unknown) {
	if (typeof tag !== 'string') return undefined
	const match = /^v(\d+)$/.exec(tag)
	if (!match) return undefined
	return Number(match[1])
}

function sortWranglerMigrations(migrations: Array<Record<string, unknown>>) {
	const orderedMigrations = migrations
		.map((migration, index) => ({
			index,
			migration,
			version: getMigrationTagVersion(migration.tag),
		}))
		.sort((left, right) => {
			if (
				left.version === undefined ||
				right.version === undefined ||
				left.version === right.version
			) {
				return left.index - right.index
			}

			return left.version - right.version
		})
		.map(({ migration }) => migration)

	migrations.splice(0, migrations.length, ...orderedMigrations)
}

function readHostnameVar(input: {
	resolvedVars: Record<string, unknown>
	varName: 'APP_BASE_URL' | 'PACKAGE_APP_BASE_URL'
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	const configured = input.resolvedVars[input.varName]
	if (typeof configured !== 'string' || !configured.trim()) return null

	let hostname: string
	try {
		hostname = new URL(configured.trim()).hostname
	} catch {
		return fail(
			`wrangler config "${input.baseConfigPath}" has an invalid "env.${input.envName}.vars.${input.varName}": ${configured}`,
		)
	}
	if (!hostname) {
		return fail(
			`wrangler config "${input.baseConfigPath}" has a "env.${input.envName}.vars.${input.varName}" without a hostname: ${configured}`,
		)
	}
	return hostname
}

/**
 * Publish the Worker's Cloudflare custom domains, derived from the environment's
 * `APP_BASE_URL` and `PACKAGE_APP_BASE_URL`.
 *
 * **`routes` is the complete custom-domain set for the script, not an addition to
 * it.** A deploy that lists only the package-app domain detaches the app origin
 * and deletes its DNS record, which takes production down. So the app origin is
 * always listed alongside the package-app origin, and a package-app origin
 * without an app origin fails the deploy instead of publishing a partial set.
 *
 * The routes are generated instead of committed because Wrangler resolves **local
 * dev** request URLs against the first configured route: a committed
 * `custom_domain` route makes every `npm run dev` request arrive as
 * `https://<that host>/...`, so local logins and redirects leave localhost.
 * Deriving them from the vars also keeps routing and provisioning from drifting —
 * the hosts the Worker routes on are the hosts the deploy attaches.
 *
 * Environments with no `PACKAGE_APP_BASE_URL` (preview, test) publish no routes
 * at all and keep whatever domains were attached out-of-band.
 */
function addPackageAppCustomDomainRoute(input: {
	targetEnv: Record<string, unknown>
	resolvedVars: Record<string, unknown>
	baseConfigPath: string
	envName: WranglerEnvName
}) {
	const packageAppHostname = readHostnameVar({
		resolvedVars: input.resolvedVars,
		varName: 'PACKAGE_APP_BASE_URL',
		baseConfigPath: input.baseConfigPath,
		envName: input.envName,
	})
	if (!packageAppHostname) return

	const appHostname = readHostnameVar({
		resolvedVars: input.resolvedVars,
		varName: 'APP_BASE_URL',
		baseConfigPath: input.baseConfigPath,
		envName: input.envName,
	})
	if (!appHostname) {
		return fail(
			`wrangler config "${input.baseConfigPath}" sets "env.${input.envName}.vars.PACKAGE_APP_BASE_URL" without "APP_BASE_URL". Publishing custom domains would detach the app origin and delete its DNS record; set APP_BASE_URL for this deploy.`,
		)
	}
	if (appHostname === packageAppHostname) {
		return fail(
			`wrangler config "${input.baseConfigPath}" points "env.${input.envName}.vars.APP_BASE_URL" and "PACKAGE_APP_BASE_URL" at the same host (${appHostname}). Hosted package apps must be a separate registrable domain.`,
		)
	}

	const existingRoutes = Array.isArray(input.targetEnv.routes)
		? (input.targetEnv.routes as Array<unknown>)
		: []
	const routedHostnames = new Set(
		existingRoutes.flatMap((route) => {
			if (!route || typeof route !== 'object') return []
			const pattern = (route as Record<string, unknown>).pattern
			return typeof pattern === 'string' ? [pattern] : []
		}),
	)

	input.targetEnv.routes = [
		...existingRoutes,
		...[appHostname, packageAppHostname]
			.filter((hostname) => !routedHostnames.has(hostname))
			.map((pattern) => ({ pattern, custom_domain: true })),
	]
	// Publishing routes flips `workers_dev` to false, which removed the
	// `<name>.<subdomain>.workers.dev` trigger the deploy previously kept as a
	// backup access path (and that MCP clients may be pointed at). Ask for it
	// explicitly so adding a custom domain does not silently take it away.
	input.targetEnv.workers_dev = true
	console.error(
		`Custom domain routes: ${appHostname} (APP_BASE_URL), ${packageAppHostname} (PACKAGE_APP_BASE_URL); workers.dev trigger kept`,
	)
}

export async function writeGeneratedWranglerConfig({
	baseConfigPath,
	outConfigPath,
	envName,
	workerName,
	d1DatabaseName,
	d1DatabaseId,
	auditD1DatabaseName,
	auditD1DatabaseId,
	oauthKvId,
	bundleArtifactsKvId,
	communityAssetsBucketName,
	emailBlobsBucketName,
	workerVars,
	extraMigrations,
}: {
	baseConfigPath: string
	outConfigPath: string
	envName: WranglerEnvName
	workerName?: string
	d1DatabaseName: string
	d1DatabaseId: string
	auditD1DatabaseName: string
	auditD1DatabaseId: string
	oauthKvId: string
	bundleArtifactsKvId: string
	communityAssetsBucketName: string
	emailBlobsBucketName: string
	workerVars?: Record<string, string | undefined>
	extraMigrations?: Array<WranglerMigration>
}) {
	const baseText = await readFile(baseConfigPath, 'utf8')
	const config = parseJsonc<Record<string, unknown>>(baseText)

	const env = config.env
	if (!env || typeof env !== 'object') {
		fail(`wrangler config "${baseConfigPath}" is missing "env".`)
	}

	const targetEnv = (env as Record<string, unknown>)[envName]
	if (!targetEnv || typeof targetEnv !== 'object') {
		fail(`wrangler config "${baseConfigPath}" is missing "env.${envName}".`)
	}

	if (workerName) {
		config.name = workerName
	}

	const targetAssets = (targetEnv as Record<string, unknown>).assets
	if (
		!targetAssets ||
		typeof targetAssets !== 'object' ||
		Array.isArray(targetAssets)
	) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.assets".`,
		)
	}
	config.assets = { ...(targetAssets as Record<string, unknown>) }

	const d1Databases = (targetEnv as Record<string, unknown>).d1_databases
	if (!Array.isArray(d1Databases)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.d1_databases".`,
		)
	}

	for (const binding of [
		{
			name: 'APP_DB',
			databaseName: d1DatabaseName,
			databaseId: d1DatabaseId,
		},
		{
			name: 'AUDIT_DB',
			databaseName: auditD1DatabaseName,
			databaseId: auditD1DatabaseId,
		},
	]) {
		const entryIndex = d1Databases.findIndex((entry) => {
			if (!entry || typeof entry !== 'object') return false
			return (entry as Record<string, unknown>).binding === binding.name
		})
		if (entryIndex < 0) {
			fail(
				`wrangler config "${baseConfigPath}" has no ${envName} D1 binding for "${binding.name}".`,
			)
		}
		const entry = d1Databases[entryIndex] as Record<string, unknown>
		d1Databases[entryIndex] = {
			...entry,
			database_name: binding.databaseName,
			database_id: binding.databaseId,
		}
	}

	const kvNamespaces = (targetEnv as Record<string, unknown>).kv_namespaces
	if (!Array.isArray(kvNamespaces)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.kv_namespaces".`,
		)
	}

	const oauthKvEntryIndex = kvNamespaces.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'OAUTH_KV'
	})
	if (oauthKvEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} KV binding for "OAUTH_KV".`,
		)
	}

	const oauthKvEntry = kvNamespaces[oauthKvEntryIndex] as Record<
		string,
		unknown
	>
	kvNamespaces[oauthKvEntryIndex] = {
		...oauthKvEntry,
		id: oauthKvId,
		preview_id: oauthKvId,
	}

	const bundleArtifactsKvEntryIndex = kvNamespaces.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'BUNDLE_ARTIFACTS_KV'
	})
	if (bundleArtifactsKvEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} KV binding for "BUNDLE_ARTIFACTS_KV".`,
		)
	}

	const bundleArtifactsKvEntry = kvNamespaces[
		bundleArtifactsKvEntryIndex
	] as Record<string, unknown>
	kvNamespaces[bundleArtifactsKvEntryIndex] = {
		...bundleArtifactsKvEntry,
		id: bundleArtifactsKvId,
		preview_id: bundleArtifactsKvId,
	}

	const r2Buckets = (targetEnv as Record<string, unknown>).r2_buckets
	if (!Array.isArray(r2Buckets)) {
		fail(
			`wrangler config "${baseConfigPath}" is missing "env.${envName}.r2_buckets".`,
		)
	}

	const communityAssetsEntryIndex = r2Buckets.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'COMMUNITY_ASSETS'
	})
	if (communityAssetsEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} R2 binding for "COMMUNITY_ASSETS".`,
		)
	}

	const communityAssetsEntry = r2Buckets[communityAssetsEntryIndex] as Record<
		string,
		unknown
	>
	r2Buckets[communityAssetsEntryIndex] = {
		...communityAssetsEntry,
		bucket_name: communityAssetsBucketName,
	}

	const emailBlobsEntryIndex = r2Buckets.findIndex((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'EMAIL_BLOBS'
	})
	if (emailBlobsEntryIndex < 0) {
		fail(
			`wrangler config "${baseConfigPath}" has no ${envName} R2 binding for "EMAIL_BLOBS".`,
		)
	}

	const emailBlobsEntry = r2Buckets[emailBlobsEntryIndex] as Record<
		string,
		unknown
	>
	r2Buckets[emailBlobsEntryIndex] = {
		...emailBlobsEntry,
		bucket_name: emailBlobsBucketName,
	}

	const existingVars = (targetEnv as Record<string, unknown>).vars
	if (
		existingVars !== undefined &&
		(existingVars === null ||
			typeof existingVars !== 'object' ||
			Array.isArray(existingVars))
	) {
		fail(
			`wrangler config "${baseConfigPath}" has invalid "env.${envName}.vars".`,
		)
	}

	const resolvedVars = {
		...((existingVars as Record<string, unknown> | undefined) ?? {}),
	}
	for (const [key, value] of Object.entries(workerVars ?? {})) {
		if (typeof value === 'string' && value.length > 0) {
			resolvedVars[key] = value
		}
	}
	;(targetEnv as Record<string, unknown>).vars = resolvedVars

	addPackageAppCustomDomainRoute({
		targetEnv: targetEnv as Record<string, unknown>,
		resolvedVars,
		baseConfigPath,
		envName,
	})

	const migrations = config.migrations
	if (extraMigrations && extraMigrations.length > 0) {
		if (!Array.isArray(migrations)) {
			fail(
				`wrangler config "${baseConfigPath}" is missing top-level "migrations".`,
			)
		}

		const migrationList = migrations as Array<Record<string, unknown>>
		for (const extraMigration of extraMigrations) {
			const alreadyExists = migrationList.some((migration) => {
				return migration.tag === extraMigration.tag
			})
			if (!alreadyExists) {
				migrationList.push(extraMigration)
			}
		}
		sortWranglerMigrations(migrationList)
	}

	const resolvedOut = path.resolve(outConfigPath)
	await writeFile(
		resolvedOut,
		`${JSON.stringify(config, null, '\t')}\n`,
		'utf8',
	)
	console.error(`Wrote generated Wrangler config: ${resolvedOut}`)
	return resolvedOut
}
