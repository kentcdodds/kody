import { readFile, writeFile } from 'node:fs/promises'
import {
	getCreditsEligiblePriceIds,
	getMatchingPriceIdsForPlan,
	type BillingEnv,
} from '#worker/billing/billing-config.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import { buildPreviewResourceNames } from '../ci/preview-resources.ts'
import { defaultOauthKvTitle } from '../ci/production-resources.ts'
import { cloudflareApiRequest, fail, parseJsonc } from '../ci/resource-utils.ts'
import {
	assertRehearsalWorkerName,
	queryD1,
	type CloudflareClient,
} from '../preview-rehearsal/d1-rehearsal.ts'
import {
	importRecipientPublicKey,
	sealJson,
} from '../preview-rehearsal/seal.ts'

/**
 * Read-only production queries that stay useful after the Teams P8 conversion
 * (docs/contributing/teams-production-queries.md): OAuth grant org binding and
 * live Stripe subscriptions. Counts only. Every request is a KV read or a
 * Stripe GET, and the report leaves only as an envelope sealed to the
 * operator's key. Credential exposure is a separate script.
 */

export type QueryTarget =
	| { kind: 'production' }
	| { kind: 'preview'; workerName: string }

export function parseQueryTarget(value: string): QueryTarget {
	if (value === 'production') return { kind: 'production' }
	return { kind: 'preview', workerName: assertRehearsalWorkerName(value) }
}

const defaultWranglerConfigPath = 'packages/worker/wrangler.jsonc'

/**
 * The production OAuth KV title the way `production-resources.ts ensure`
 * resolves it: a title on the `env.production` OAUTH_KV binding wins, else the
 * default derived from the worker name (`kody` -> `kody-oauth`).
 */
export async function resolveProductionOauthKvTitle(
	wranglerPath = defaultWranglerConfigPath,
) {
	const config = parseJsonc<{
		name?: unknown
		env?: {
			production?: {
				kv_namespaces?: Array<{ binding?: unknown; title?: unknown }>
			}
		}
	}>(await readFile(wranglerPath, 'utf8'))
	if (typeof config.name !== 'string' || !config.name) {
		throw new Error(`${wranglerPath} is missing the top-level worker name.`)
	}
	const entry = config.env?.production?.kv_namespaces?.find(
		(candidate) => candidate.binding === 'OAUTH_KV',
	)
	if (!entry) {
		throw new Error(
			`${wranglerPath} has no env.production OAUTH_KV kv_namespaces binding.`,
		)
	}
	return typeof entry.title === 'string' && entry.title.length > 0
		? entry.title
		: defaultOauthKvTitle(config.name)
}

export function targetAppD1Name(target: QueryTarget) {
	switch (target.kind) {
		case 'production':
			return 'kody'
		case 'preview':
			return buildPreviewResourceNames(target.workerName).d1DatabaseName
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown query target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

export async function targetResourceNames(
	target: QueryTarget,
	wranglerPath = defaultWranglerConfigPath,
) {
	switch (target.kind) {
		case 'production':
			return {
				appD1Name: targetAppD1Name(target),
				oauthKvTitle: await resolveProductionOauthKvTitle(wranglerPath),
			}
		case 'preview': {
			const names = buildPreviewResourceNames(target.workerName)
			return {
				appD1Name: targetAppD1Name(target),
				oauthKvTitle: names.oauthKvTitle,
			}
		}
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown query target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

const writeKeywords = [
	'alter',
	'analyze',
	'attach',
	'begin',
	'commit',
	'create',
	'delete',
	'detach',
	'drop',
	'insert',
	'pragma',
	'reindex',
	'release',
	'replace',
	'rollback',
	'savepoint',
	'update',
	'upsert',
	'vacuum',
]

/**
 * D1's query API runs whatever it is sent, and the CI token can write. Only a
 * single SELECT (or WITH ... SELECT) statement with no comments and no write
 * keyword anywhere is allowed through, even inside string literals: a false
 * positive fails loudly instead of risking a production write.
 */
export function assertReadOnlySql(sql: string) {
	const trimmed = sql.trim()
	if (!/^(select|with)\b/i.test(trimmed)) {
		throw new Error('Read-only query must start with SELECT or WITH.')
	}
	if (trimmed.replace(/;\s*$/, '').includes(';')) {
		throw new Error('Read-only query must be a single statement.')
	}
	if (/--|\/\*/.test(trimmed)) {
		throw new Error('Read-only query must not contain SQL comments.')
	}
	const keyword = writeKeywords.find((word) =>
		new RegExp(`\\b${word}\\b`, 'i').test(trimmed),
	)
	if (keyword) {
		throw new Error(`Read-only query must not contain "${keyword}".`)
	}
	return trimmed
}

export async function readOnlyD1Query<Row>(
	client: CloudflareClient,
	uuid: string,
	sql: string,
) {
	return queryD1<Row>(client, uuid, assertReadOnlySql(sql))
}

export type OAuthGrantCounts = {
	grants: number
	withOrgId: number
	withoutOrgId: number
	users: number
}

export const stripePriceMappings = [
	'purchasable-pro',
	'retired-standard',
	'retired-pro',
	'unmapped',
] as const
export type StripePriceMapping = (typeof stripePriceMappings)[number]

export type StripeSubscriptionCounts =
	| {
			skipped: false
			subscriptions: number
			unmapped: number
			byPrice: Array<{
				priceId: string
				status: string
				mapping: StripePriceMapping
				subscriptions: number
			}>
	  }
	| { skipped: true; reason: string }

export type ProductionQueryReport = {
	version: 2
	target: string
	ranAt: string
	oauthGrants: OAuthGrantCounts
	stripeSubscriptions: StripeSubscriptionCounts
}

export async function resolveD1Uuid(client: CloudflareClient, name: string) {
	const response = await cloudflareApiRequest<
		Array<{ uuid: string; name: string }>
	>({
		...client,
		pathname: `/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
	})
	const match = (response.result ?? []).find((entry) => entry.name === name)
	if (!match) throw new Error(`D1 database ${name} does not exist.`)
	return match.uuid
}

async function resolveKvNamespaceId(client: CloudflareClient, title: string) {
	for (let page = 1; ; page += 1) {
		const response = await cloudflareApiRequest<
			Array<{ id: string; title: string }>
		>({
			...client,
			pathname: `/storage/kv/namespaces?per_page=100&page=${page}`,
		})
		const namespaces = response.result ?? []
		const match = namespaces.find((entry) => entry.title === title)
		if (match) return match.id
		if (namespaces.length < 100) {
			throw new Error(`KV namespace ${title} does not exist.`)
		}
	}
}

const kvBulkGetLimit = 100

/**
 * workers-oauth-provider stores each grant at `grant:<userId>:<grantId>` with
 * a plaintext `metadata` object; props stay encrypted and are never read.
 */
export async function countOAuthGrants(
	client: CloudflareClient,
	namespaceId: string,
): Promise<OAuthGrantCounts> {
	const keys: Array<string> = []
	let cursor: string | undefined
	do {
		const query = new URLSearchParams({ prefix: 'grant:', limit: '1000' })
		if (cursor) query.set('cursor', cursor)
		const response = await cloudflareApiRequest<Array<{ name: string }>>({
			...client,
			pathname: `/storage/kv/namespaces/${namespaceId}/keys?${query}`,
		})
		keys.push(...(response.result ?? []).map((entry) => entry.name))
		const next = response.result_info?.cursor
		cursor = next && next !== cursor ? next : undefined
	} while (cursor)

	let withOrgId = 0
	const users = new Set<string>()
	for (let index = 0; index < keys.length; index += kvBulkGetLimit) {
		const batch = keys.slice(index, index + kvBulkGetLimit)
		const response = await cloudflareApiRequest<{
			values?: Record<string, unknown>
		}>({
			...client,
			pathname: `/storage/kv/namespaces/${namespaceId}/bulk/get`,
			method: 'POST',
			body: { keys: batch, type: 'json' },
		})
		const values = response.result?.values ?? {}
		for (const key of batch) {
			if (!(key in values)) {
				throw new Error(`KV bulk get returned no value for an OAuth grant.`)
			}
			const userId = key.split(':')[1]
			if (userId) users.add(userId)
			if (grantHasOrgId(values[key])) withOrgId += 1
		}
	}
	return {
		grants: keys.length,
		withOrgId,
		withoutOrgId: keys.length - withOrgId,
		users: users.size,
	}
}

export function grantHasOrgId(value: unknown) {
	if (typeof value !== 'object' || value === null) return false
	const metadata = (value as { metadata?: unknown }).metadata
	if (typeof metadata !== 'object' || metadata === null) return false
	const orgId = (metadata as { orgId?: unknown }).orgId
	return typeof orgId === 'string' && orgId.length > 0
}

export function classifyStripePrice(
	env: BillingEnv,
	priceId: string,
): StripePriceMapping {
	if (getCreditsEligiblePriceIds(env).includes(priceId)) {
		return 'purchasable-pro'
	}
	if (getMatchingPriceIdsForPlan(env, 'standard').includes(priceId)) {
		return 'retired-standard'
	}
	if (getMatchingPriceIdsForPlan(env, 'pro').includes(priceId)) {
		return 'retired-pro'
	}
	return 'unmapped'
}

/** Ended subscriptions never move to an org (§7.2). */
const endedSubscriptionStatuses = new Set(['canceled', 'incomplete_expired'])

type StripeList<Item> = { data: Array<Item>; has_more: boolean }
type StripeSubscriptionItem = { id: string; price: { id: string } }
type StripeSubscription = {
	id: string
	status: string
	items: StripeList<StripeSubscriptionItem>
}

export async function countStripeSubscriptions(input: {
	secretKey: string
	billingEnv: BillingEnv
	apiBaseUrl?: string
	fetcher?: typeof fetch
}): Promise<StripeSubscriptionCounts> {
	const fetcher = input.fetcher ?? fetch
	const baseUrl = input.apiBaseUrl ?? 'https://api.stripe.com'
	const stripeGet = async <Item>(
		pathname: string,
		params: Record<string, string>,
	) => {
		const url = new URL(pathname, baseUrl)
		for (const [name, value] of Object.entries(params)) {
			url.searchParams.set(name, value)
		}
		const response = await fetcher(url, {
			method: 'GET',
			headers: { authorization: `Bearer ${input.secretKey}` },
		})
		if (!response.ok) {
			throw new Error(`Stripe GET ${pathname} failed (${response.status}).`)
		}
		return (await response.json()) as StripeList<Item>
	}
	/** Stripe embeds only the first page of a subscription's items. */
	const readPriceIds = async (subscription: StripeSubscription) => {
		const items = [...subscription.items.data]
		let more = subscription.items.has_more
		while (more) {
			const page = await stripeGet<StripeSubscriptionItem>(
				'/v1/subscription_items',
				{
					subscription: subscription.id,
					limit: '100',
					starting_after: items.at(-1)?.id ?? '',
				},
			)
			items.push(...page.data)
			more = page.has_more && page.data.length > 0
		}
		return new Set(items.map((item) => item.price.id))
	}

	const counts = new Map<
		string,
		{ priceId: string; status: string; subscriptions: number }
	>()
	let subscriptions = 0
	let unmapped = 0
	let startingAfter: string | undefined
	do {
		const page = await stripeGet<StripeSubscription>('/v1/subscriptions', {
			status: 'all',
			limit: '100',
			...(startingAfter ? { starting_after: startingAfter } : {}),
		})
		for (const subscription of page.data) {
			if (endedSubscriptionStatuses.has(subscription.status)) continue
			subscriptions += 1
			const priceIds = await readPriceIds(subscription)
			if (
				[...priceIds].some(
					(priceId) =>
						classifyStripePrice(input.billingEnv, priceId) === 'unmapped',
				)
			) {
				unmapped += 1
			}
			for (const priceId of priceIds) {
				const key = `${priceId}\u0000${subscription.status}`
				const entry = counts.get(key) ?? {
					priceId,
					status: subscription.status,
					subscriptions: 0,
				}
				entry.subscriptions += 1
				counts.set(key, entry)
			}
		}
		startingAfter = page.has_more ? page.data.at(-1)?.id : undefined
	} while (startingAfter)

	const byPrice = [...counts.values()]
		.map((entry) => ({
			...entry,
			mapping: classifyStripePrice(input.billingEnv, entry.priceId),
		}))
		.sort(
			(a, b) =>
				a.priceId.localeCompare(b.priceId) || a.status.localeCompare(b.status),
		)
	return { skipped: false, subscriptions, unmapped, byPrice }
}

/** Production price ids come from the committed Wrangler vars. */
export async function readProductionBillingEnv(
	wranglerPath = 'packages/worker/wrangler.jsonc',
): Promise<BillingEnv> {
	const config = parseJsonc<{
		env?: { production?: { vars?: Record<string, unknown> } }
	}>(await readFile(wranglerPath, 'utf8'))
	const vars = config.env?.production?.vars ?? {}
	const read = (name: keyof BillingEnv) => {
		const value = vars[name]
		if (typeof value !== 'string' || !value.trim()) {
			throw new Error(`${wranglerPath} env.production.vars.${name} is unset.`)
		}
		return value
	}
	return {
		STRIPE_PRO_PRICE_ID: read('STRIPE_PRO_PRICE_ID'),
		STRIPE_PRO_YEARLY_PRICE_ID: read('STRIPE_PRO_YEARLY_PRICE_ID'),
	}
}

export async function runProductionQueries(input: {
	client: CloudflareClient
	target: QueryTarget
	stripe:
		| { secretKey: string; billingEnv: BillingEnv; fetcher?: typeof fetch }
		| { skipReason: string }
	now?: () => Date
}): Promise<ProductionQueryReport> {
	const { client, target } = input
	const names = await targetResourceNames(target)
	const oauthGrants = await countOAuthGrants(
		client,
		await resolveKvNamespaceId(client, names.oauthKvTitle),
	)

	const stripeSubscriptions: StripeSubscriptionCounts =
		'skipReason' in input.stripe
			? { skipped: true, reason: input.stripe.skipReason }
			: await countStripeSubscriptions(input.stripe)

	return {
		version: 2,
		target: target.kind === 'production' ? 'production' : target.workerName,
		ranAt: (input.now ?? (() => new Date()))().toISOString(),
		oauthGrants,
		stripeSubscriptions,
	}
}

export const previewStripeSkipReason = 'Branch previews have no Stripe account.'
export const missingStripeSecretSkipReason =
	'STRIPE_SECRET_KEY is unset; Stripe subscription counts were skipped.'

/**
 * Production can count live Stripe subscriptions only when the Actions (or
 * local) secret is present. Billing is optional on the Worker, so a missing
 * key skips Stripe counts instead of aborting the OAuth KV query.
 */
export function resolveProductionStripe(
	secretKey: string | undefined,
	billingEnv: BillingEnv,
): { secretKey: string; billingEnv: BillingEnv } | { skipReason: string } {
	const key = secretKey?.trim()
	if (!key) return { skipReason: missingStripeSecretSkipReason }
	return { secretKey: key, billingEnv }
}

const usage = [
	'Usage: node tools/teams-migration/production-queries.ts --target <production|kody-branch-*> --recipient-public-key <base64 SPKI> --out <report.sealed.json>',
	'',
	'Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; STRIPE_SECRET_KEY for --target production Stripe counts (skipped when unset).',
].join('\n')

function readFlag(argv: ReadonlyArray<string>, flag: string) {
	const index = argv.indexOf(flag)
	const value = index === -1 ? undefined : argv[index + 1]
	if (!value || value.startsWith('--'))
		fail(`Missing ${flag} <value>.\n${usage}`)
	return value
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) fail(`${name} is required.\n${usage}`)
	return value
}

if (isExecutedDirectly(import.meta.url)) {
	const argv = process.argv.slice(2)
	const target = parseQueryTarget(readFlag(argv, '--target'))
	const publicKey = await importRecipientPublicKey(
		readFlag(argv, '--recipient-public-key'),
	)
	const outPath = readFlag(argv, '--out')
	const client: CloudflareClient = {
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
	}
	let stripe:
		| { secretKey: string; billingEnv: BillingEnv }
		| { skipReason: string }
	switch (target.kind) {
		case 'production':
			stripe = resolveProductionStripe(
				process.env.STRIPE_SECRET_KEY,
				await readProductionBillingEnv(),
			)
			if ('skipReason' in stripe) console.warn(stripe.skipReason)
			break
		case 'preview':
			stripe = { skipReason: previewStripeSkipReason }
			break
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown query target: ${JSON.stringify(exhaustive)}`)
		}
	}
	const report = await runProductionQueries({
		client,
		target,
		stripe,
	})
	await writeFile(
		outPath,
		`${JSON.stringify(await sealJson(report, publicKey), null, 2)}\n`,
	)
	console.log(
		`Wrote the sealed report to ${outPath}. Open it with node tools/preview-rehearsal/seal.ts open.`,
	)
}
