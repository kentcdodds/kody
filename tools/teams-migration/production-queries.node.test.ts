import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	assertReadOnlySql,
	classifyStripePrice,
	crossPlatformScopeDependenciesSql,
	parseQueryTarget,
	platformAccountsSql,
	readProductionBillingEnv,
	resolveProductionOauthKvTitle,
	resolveProductionStripe,
	runProductionQueries,
	sharedPackageImportsSql,
	targetResourceNames,
} from './production-queries.ts'

const proPriceId = 'price_pro_month'
const billingEnv = {
	STRIPE_PRO_PRICE_ID: proPriceId,
	STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_year',
}
const retiredProPriceId = 'price_1UChg1LAQpAnsYszAYn6eGgt'
const retiredStandardPriceId = 'price_1U3sg6LAQpAnsYszGeL2nc8O'

function createAppDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../packages/worker/migrations/', import.meta.url),
	)
	const run = (sql: string, ...values: Array<SQLInputValue>) =>
		sqlite.prepare(sql).run(...values)
	const users = [
		[1, 'kody', 'kody-id', 'platform'],
		[2, 'tools', 'tools-id', 'platform'],
		[3, 'alice', 'alice-id', 'person'],
		[4, 'carol', 'carol-id', 'person'],
	] as const
	for (const [id, username, stableUserId, accountType] of users) {
		run(
			`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id, account_type)
			VALUES (?, ?, ?, 'hash', '2026-10-01', '2026-10-01', ?, ?)`,
			id,
			username,
			`${username}@example.com`,
			stableUserId,
			accountType,
		)
	}
	run(
		`INSERT INTO package_scope_grants (scope_owner_user_id, grantee_user_id, created_by_user_id) VALUES ('kody-id', 'alice-id', 'kody-id')`,
	)
	const packages = [
		['kody-a', 'kody-id', 0, 0],
		['kody-b', 'kody-id', 1, 1],
		['tools-x', 'tools-id', 0, 0],
		['alice-shared', 'alice-id', 1, 0],
		['carol-guest', 'carol-id', 1, 0],
		['carol-own', 'carol-id', 1, 0],
	] as const
	for (const [id, userId, isPrivate, hidden] of packages) {
		run(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, is_private, hidden)
			VALUES (?, ?, ?, ?, 'pkg', ?, ?, ?)`,
			id,
			userId,
			id,
			id,
			`src-${id}`,
			isPrivate,
			hidden,
		)
		run(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, published_commit, created_at, updated_at)
			VALUES (?, ?, 'package', ?, ?, 'c2', '2026-10-01', '2026-10-01')`,
			`src-${id}`,
			userId,
			id,
			`repo-${id}`,
		)
	}
	const dependency = (
		packageId: string,
		extra: Record<string, unknown> = {},
	) => ({
		sourceId: `src-${packageId}`,
		publishedCommit: 'c2',
		kodyId: packageId,
		packageId,
		...extra,
	})
	const artifacts = [
		[
			'kody-a',
			'kody-id',
			'c2',
			[dependency('tools-x', { platformOwned: true }), dependency('kody-b')],
		],
		// An older commit's artifact is no longer an import.
		[
			'kody-b',
			'kody-id',
			'c1',
			[dependency('tools-x', { platformOwned: true })],
		],
		[
			'carol-guest',
			'carol-id',
			'c2',
			[
				dependency('alice-shared', {
					shareOwned: true,
					storageOwnerUserId: 'alice-id',
				}),
				dependency('carol-own'),
				dependency('kody-a', { platformOwned: true, transitive: true }),
			],
		],
	] as const
	const insertArtifact = (
		packageId: string,
		userId: string,
		commit: string,
		entryPoint: string,
		dependencies: ReadonlyArray<object>,
	) =>
		run(
			`INSERT INTO published_bundle_artifacts (id, user_id, source_id, published_commit, artifact_kind, entry_point, kv_key, dependencies_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'module', ?, 'kv', ?, '2026-10-01', '2026-10-01')`,
			`artifact-${packageId}-${commit}-${entryPoint}`,
			userId,
			`src-${packageId}`,
			commit,
			entryPoint,
			JSON.stringify(dependencies),
		)
	for (const [packageId, userId, commit, dependencies] of artifacts) {
		insertArtifact(packageId, userId, commit, 'index.ts', dependencies)
	}
	// Another export of the same packages reaches the same dependency
	// transitively; each import still reports once, as direct.
	insertArtifact('kody-a', 'kody-id', 'c2', 'app.ts', [
		dependency('tools-x', { platformOwned: true, transitive: true }),
	])
	insertArtifact('carol-guest', 'carol-id', 'c2', 'app.ts', [
		dependency('alice-shared', {
			shareOwned: true,
			storageOwnerUserId: 'alice-id',
			transitive: true,
		}),
	])
	// A revoked earlier share and the current accepted one.
	run(
		`INSERT INTO package_share_grants (id, package_id, owner_user_id, grantee_user_id, status, invited_at, updated_at)
		VALUES ('share-0', 'alice-shared', 'alice-id', 'carol-id', 'revoked', '2026-09-01', '2026-09-02')`,
	)
	run(
		`INSERT INTO package_share_grants (id, package_id, owner_user_id, grantee_user_id, status, invited_at, updated_at)
		VALUES ('share-1', 'alice-shared', 'alice-id', 'carol-id', 'accepted', '2026-10-01', '2026-10-01')`,
	)
	return sqlite
}

const kvGrants: Record<string, unknown> = {
	'grant:alice-id:g1': { id: 'g1', metadata: { clientId: 'host' } },
	'grant:carol-id:g2': { id: 'g2', metadata: { orgId: 'carol-id' } },
	'grant:carol-id:g3': { id: 'g3', encryptedProps: 'ciphertext' },
	'token:carol-id:g2:t1': { id: 't1' },
}

function createFakeApis(sqlite: DatabaseSync) {
	const requests: Array<string> = []
	const querySql: Array<string> = []
	const ok = (result: unknown, resultInfo?: unknown) =>
		Response.json({ success: true, result, result_info: resultInfo })
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/accounts\/acct/, '')
		requests.push(`${method} ${path}`)
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		if (path === '/d1/database' && method === 'GET') {
			return ok([{ name: url.searchParams.get('name'), uuid: 'app-uuid' }])
		}
		if (path === '/d1/database/app-uuid/query' && method === 'POST') {
			querySql.push(body.sql)
			return ok([{ results: sqlite.prepare(body.sql).all(), success: true }])
		}
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
	return { fetcher, requests, querySql }
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
		platformAccountsSql,
		crossPlatformScopeDependenciesSql,
		sharedPackageImportsSql,
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

test('runProductionQueries answers all five questions with reads only', async () => {
	const sqlite = createAppDb()
	const cloudflare = createFakeApis(sqlite)
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
		version: 1,
		target: 'production',
		ranAt: '2026-10-08T00:00:00.000Z',
		platformAccounts: {
			count: 2,
			rows: [
				{
					userId: 1,
					username: 'kody',
					packages: 2,
					publicPackages: 1,
					hiddenPackages: 1,
					scopeGrantees: 1,
				},
				{
					userId: 2,
					username: 'tools',
					packages: 1,
					publicPackages: 1,
					hiddenPackages: 0,
					scopeGrantees: 0,
				},
			],
		},
		crossPlatformScopeDependencies: {
			count: 1,
			rows: [
				{
					packageId: 'kody-a',
					scope: 'kody',
					dependencyPackageId: 'tools-x',
					dependencyScope: 'tools',
					transitive: false,
				},
			],
		},
		sharedPackageImports: {
			count: 1,
			rows: [
				{
					guestPackageId: 'carol-guest',
					sharedPackageId: 'alice-shared',
					shareGrantId: 'share-1',
					shareStatus: 'accepted',
					transitive: false,
				},
			],
		},
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
	expect(cloudflare.querySql).toEqual([
		platformAccountsSql,
		crossPlatformScopeDependenciesSql,
		sharedPackageImportsSql,
	])
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

test('runProductionQueries still answers D1 and KV questions when Stripe is skipped', async () => {
	const sqlite = createAppDb()
	const cloudflare = createFakeApis(sqlite)
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

	expect(report.platformAccounts.count).toBe(2)
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
