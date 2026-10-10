import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	assertReadOnlySql,
	classifyStripePrice,
	parseQueryTarget,
	readProductionBillingEnv,
	resolveProductionOauthKvTitle,
	resolveProductionStripe,
	runProductionQueries,
	targetResourceNames,
} from './production-queries.ts'

const proPriceId = 'price_pro_month'
const billingEnv = {
	STRIPE_PRO_PRICE_ID: proPriceId,
	STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_year',
}
const retiredProPriceId = 'price_1UChg1LAQpAnsYszAYn6eGgt'
const retiredStandardPriceId = 'price_1U3sg6LAQpAnsYszGeL2nc8O'

const kvGrants: Record<string, unknown> = {
	'grant:alice-id:g1': { id: 'g1', metadata: { clientId: 'host' } },
	'grant:carol-id:g2': { id: 'g2', metadata: { orgId: 'carol-id' } },
	'grant:carol-id:g3': { id: 'g3', encryptedProps: 'ciphertext' },
	'token:carol-id:g2:t1': { id: 't1' },
}

function createFakeApis() {
	const requests: Array<string> = []
	const ok = (result: unknown, resultInfo?: unknown) =>
		Response.json({ success: true, result, result_info: resultInfo })
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/accounts\/acct/, '')
		requests.push(`${method} ${path}`)
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		if (path === '/storage/kv/namespaces' && method === 'GET') {
			return ok([{ id: 'oauth-kv', title: 'kody-oauth' }])
		}
		if (path === '/storage/kv/namespaces/oauth-kv/keys' && method === 'GET') {
			const prefix = url.searchParams.get('prefix') ?? ''
			const names = Object.keys(kvGrants).filter((key) =>
				key.startsWith(prefix),
			)
			// Two pages, so the cursor loop is exercised.
			if (!url.searchParams.get('cursor')) {
				return ok(
					names.slice(0, 2).map((name) => ({ name })),
					{ cursor: 'page-2' },
				)
			}
			return ok(
				names.slice(2).map((name) => ({ name })),
				{ cursor: '' },
			)
		}
		if (
			path === '/storage/kv/namespaces/oauth-kv/bulk/get' &&
			method === 'POST'
		) {
			expect(body.type).toBe('json')
			return ok({
				values: Object.fromEntries(
					(body.keys as Array<string>).map((key) => [key, kvGrants[key]]),
				),
			})
		}
		throw new Error(`Unexpected Cloudflare request ${method} ${path}`)
	}
	return { fetcher, requests }
}

function createFakeStripe() {
	const subscription = (
		id: string,
		status: string,
		priceIds: Array<string>,
		hasMoreItems = false,
	) => ({
		id,
		status,
		items: {
			data: priceIds.map((priceId, index) => ({
				id: `${id}_item_${index}`,
				price: { id: priceId },
			})),
			has_more: hasMoreItems,
		},
	})
	const pages = [
		{
			data: [
				subscription('sub_1', 'active', [proPriceId]),
				subscription('sub_2', 'active', [proPriceId]),
				subscription('sub_3', 'trialing', [retiredProPriceId]),
			],
			has_more: true,
		},
		{
			data: [
				subscription('sub_4', 'canceled', ['price_gone']),
				subscription('sub_5', 'past_due', [retiredStandardPriceId]),
				// Two unmapped prices, the second past the embedded item page.
				subscription('sub_6', 'active', ['price_new'], true),
			],
			has_more: false,
		},
	]
	const requests: Array<string> = []
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		requests.push(`${init?.method} ${url.pathname}?${url.searchParams}`)
		expect(init?.method).toBe('GET')
		if (url.pathname === '/v1/subscription_items') {
			expect(url.searchParams.get('subscription')).toBe('sub_6')
			expect(url.searchParams.get('starting_after')).toBe('sub_6_item_0')
			return Response.json({
				data: [{ id: 'sub_6_item_1', price: { id: 'price_new_b' } }],
				has_more: false,
			})
		}
		const page = url.searchParams.get('starting_after') === 'sub_3' ? 1 : 0
		return Response.json(pages[page])
	}
	return { fetcher, requests }
}

test('assertReadOnlySql allows one SELECT and refuses anything that could write', () => {
	for (const sql of [
		'SELECT COUNT(*) FROM grants',
		'WITH x AS (SELECT 1) SELECT * FROM x;',
	]) {
		expect(assertReadOnlySql(sql)).toBeTruthy()
	}
	const refusals: Array<[string, RegExp]> = [
		['DELETE FROM users', /must start with SELECT or WITH/],
		['SELECT 1; DELETE FROM users', /single statement/],
		['WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x', /"delete"/],
		['SELECT 1 -- note', /comments/],
		['SELECT 1 /* note */', /comments/],
		["SELECT * FROM users WHERE username = 'drop'", /"drop"/],
		['  pragma table_info(users)', /must start with SELECT or WITH/],
		['SELECT 1 UNION SELECT 2 FROM (REPLACE INTO x VALUES (1))', /"replace"/],
	]
	for (const [sql, message] of refusals) {
		expect(() => assertReadOnlySql(sql)).toThrow(message)
	}
})

test('runProductionQueries answers OAuth and Stripe with reads only', async () => {
	const cloudflare = createFakeApis()
	const stripe = createFakeStripe()

	const report = await runProductionQueries({
		client: {
			accountId: 'acct',
			apiToken: 'token',
			fetcher: cloudflare.fetcher,
		},
		target: parseQueryTarget('production'),
		stripe: { secretKey: 'sk_test', billingEnv, fetcher: stripe.fetcher },
		now: () => new Date('2026-10-08T00:00:00.000Z'),
	})

	expect(report).toEqual({
		version: 2,
		target: 'production',
		ranAt: '2026-10-08T00:00:00.000Z',
		oauthGrants: { grants: 3, withOrgId: 1, withoutOrgId: 2, users: 2 },
		stripeSubscriptions: {
			skipped: false,
			subscriptions: 5,
			unmapped: 1,
			byPrice: [
				{
					priceId: 'price_1U3sg6LAQpAnsYszGeL2nc8O',
					status: 'past_due',
					mapping: 'retired-standard',
					subscriptions: 1,
				},
				{
					priceId: 'price_1UChg1LAQpAnsYszAYn6eGgt',
					status: 'trialing',
					mapping: 'retired-pro',
					subscriptions: 1,
				},
				{
					priceId: 'price_new',
					status: 'active',
					mapping: 'unmapped',
					subscriptions: 1,
				},
				{
					priceId: 'price_new_b',
					status: 'active',
					mapping: 'unmapped',
					subscriptions: 1,
				},
				{
					priceId: proPriceId,
					status: 'active',
					mapping: 'purchasable-pro',
					subscriptions: 2,
				},
			],
		},
	})

	const writes = cloudflare.requests.filter(
		(request) =>
			request.startsWith('POST') &&
			!request.endsWith('/query') &&
			!request.endsWith('/bulk/get'),
	)
	expect(writes).toEqual([])
	expect(
		cloudflare.requests.filter((request) => request.includes('/d1/')),
	).toEqual([])
	expect(stripe.requests).toEqual([
		'GET /v1/subscriptions?status=all&limit=100',
		'GET /v1/subscriptions?status=all&limit=100&starting_after=sub_3',
		'GET /v1/subscription_items?subscription=sub_6&limit=100&starting_after=sub_6_item_0',
	])
})

const unsetStripeSkipReason =
	'STRIPE_SECRET_KEY is unset; Stripe subscription counts were skipped.'

test('production Stripe counts skip when the Actions secret is unset', () => {
	expect(resolveProductionStripe(undefined, billingEnv)).toEqual({
		skipReason: unsetStripeSkipReason,
	})
	expect(resolveProductionStripe('   ', billingEnv)).toEqual({
		skipReason: unsetStripeSkipReason,
	})
	expect(resolveProductionStripe('sk_test', billingEnv)).toEqual({
		secretKey: 'sk_test',
		billingEnv,
	})
})

test('runProductionQueries still answers the OAuth KV question when Stripe is skipped', async () => {
	const cloudflare = createFakeApis()
	const report = await runProductionQueries({
		client: {
			accountId: 'acct',
			apiToken: 'token',
			fetcher: cloudflare.fetcher,
		},
		target: parseQueryTarget('production'),
		stripe: { skipReason: unsetStripeSkipReason },
		now: () => new Date('2026-10-08T00:00:00.000Z'),
	})

	expect(report.version).toBe(2)
	expect(report.oauthGrants).toEqual({
		grants: 3,
		withOrgId: 1,
		withoutOrgId: 2,
		users: 2,
	})
	expect(report.stripeSubscriptions).toEqual({
		skipped: true,
		reason: unsetStripeSkipReason,
	})
})

test('query targets refuse PR previews and the production worker name', () => {
	expect(() => parseQueryTarget('kody-pr-12')).toThrow(/branch previews/)
	expect(() => parseQueryTarget('kody-production')).toThrow(/branch previews/)
})

test('Stripe prices are classified with the worker billing config', async () => {
	const production = await readProductionBillingEnv()
	expect(production.STRIPE_PRO_PRICE_ID).toMatch(/^price_/)
	expect(classifyStripePrice(production, production.STRIPE_PRO_PRICE_ID!)).toBe(
		'purchasable-pro',
	)
	expect(classifyStripePrice(production, retiredProPriceId)).toBe('retired-pro')
	expect(classifyStripePrice(production, retiredStandardPriceId)).toBe(
		'retired-standard',
	)
	expect(classifyStripePrice(production, 'price_unknown')).toBe('unmapped')
})

test('the production OAuth KV title follows the Wrangler worker name and any title override', async () => {
	expect(await resolveProductionOauthKvTitle()).toBe('kody-oauth')
	expect(await targetResourceNames(parseQueryTarget('production'))).toEqual({
		appD1Name: 'kody',
		oauthKvTitle: 'kody-oauth',
	})

	const directory = await mkdtemp(path.join(tmpdir(), 'wrangler-'))
	const withBinding = async (binding: string) => {
		const file = path.join(directory, 'wrangler.jsonc')
		await writeFile(
			file,
			`{ "name": "kody-test", "env": { "production": { "kv_namespaces": [${binding}] } } }`,
		)
		return file
	}
	expect(
		await resolveProductionOauthKvTitle(
			await withBinding('{ "binding": "OAUTH_KV" }'),
		),
	).toBe('kody-test-oauth')
	expect(
		await resolveProductionOauthKvTitle(
			await withBinding('{ "binding": "OAUTH_KV", "title": "custom-oauth" }'),
		),
	).toBe('custom-oauth')
	await expect(
		resolveProductionOauthKvTitle(
			await withBinding('{ "binding": "BUNDLE_ARTIFACTS_KV" }'),
		),
	).rejects.toThrow(/OAUTH_KV/)
})
