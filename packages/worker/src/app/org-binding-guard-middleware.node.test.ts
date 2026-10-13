import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { routes } from '#universal/routes.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from './auth-session.ts'
import { createOrgBindingGuardMiddleware } from './org-binding-guard-middleware.ts'
import { isOrgBoundPath } from './org-request-binding.ts'
import { createAppRouter } from './router.ts'

// The illustrated page needs the full worker env; only its status matters here.
vi.mock('#app/handlers/error-pages.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	renderIllustratedNotFoundPage: () =>
		new Response('illustrated not found', { status: 404 }),
}))

const origin = 'https://kody.test'
const cookieSecret = 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'
const now = '2026-01-01T00:00:00.000Z'
const adaPersonId = testStableUserIdFromEmail('ada@example.com')

/**
 * `/account/…` routes that share a name with an org section but are keyed by
 * something other than the request org. Every entry needs a reason; the walk
 * fails on entries that no longer match a route.
 */
const personScopedAccountRoutes: Record<string, string> = {
	accountConnectionsApi: 'sign-in providers belong to the person',
	accountConnectionsApiPost: 'sign-in providers belong to the person',
	accountEmailChange: 'the login email belongs to the person',
	accountEmailClaimRelease: 'inbox claims belong to the person',
	accountEmailDestinationsApi: 'notification addresses belong to the person',
	accountEmailDestinationsApiPost:
		'notification addresses belong to the person',
	accountBillingCancellationFeedbackPost: 'feedback from the person',
	accountMcpServerLogo: 'logos are stored on the signup org',
	accountMcpServersOauthCallback: 'OAuth state carries the server owner',
	accountPackagesApi:
		'no per-package authz; teams use /@slug/-/repositories.json',
	accountPackagesApiPost:
		'no per-package authz; teams use /@slug/-/repositories.json',
	accountPackageDetail: 'package authz, not request org',
	accountPackageApprovePublish: 'package authz, not request org',
	accountPackageApprovePublishApi: 'package authz, not request org',
	accountPackageApproveCapabilities: 'package authz, not request org',
	accountPackageApproveCapabilitiesApi: 'package authz, not request org',
	accountPackageFiles: 'package authz, not request org',
	accountPackageFilesApi: 'package authz, not request org',
	accountWebhooksApproveApplyApi: 'approval link carries the webhook owner',
	accountWebhooksApproveApplyApiPost: 'approval link carries the webhook owner',
	accountWaitingClickPost: 'click analytics for the person',
}

type RouteEntry = {
	name: string
	method: string
	source: string
	href: string
}

function routeEntries(): Array<RouteEntry> {
	return Object.entries(routes).map(([name, route]) => {
		const source = route.pattern.source
		const params = Object.fromEntries(
			[...source.matchAll(/[:*](\w+)/g)].map(([, key]) => [
				key,
				key === 'orgSlug' ? 'ghost' : 'x',
			]),
		)
		return {
			name,
			method: route.method,
			source,
			href: (route.href as (params: Record<string, string>) => string)(params),
		}
	})
}

/** Sections that have a `/@:orgSlug/-/<section>` page or API. */
function orgSectionsFromRouteTable(entries: Array<RouteEntry>) {
	const sections = new Set<string>()
	for (const { source } of entries) {
		const match = /^\/@:orgSlug\/-\/([^/(.]+)/.exec(source)
		if (match?.[1]) sections.add(match[1])
	}
	return sections
}

/** `/account/<x>` routes whose first segment starts with an org section name. */
function accountRoutesNamedLikeOrgSections(entries: Array<RouteEntry>) {
	const sections = orgSectionsFromRouteTable(entries)
	return entries.filter(({ source }) => {
		const segment = /^\/account\/([^/(.]+)/.exec(source)?.[1]
		if (!segment) return false
		return [...sections].some((section) => segment.startsWith(section))
	})
}

/** Every route the guard covers, derived from the route table. */
function orgBoundRoutes(entries: Array<RouteEntry>) {
	return entries.filter(({ href }) => isOrgBoundPath(href))
}

/** Legacy `/@slug/-/packages` (+ `.json`) only 301 to `/repositories`. */
const legacyOrgListRedirectRoutes = new Set(['orgPackages', 'orgPackagesApi'])

test('every org-scoped route in the route table is bound to its org', () => {
	const entries = routeEntries()
	const orgRoutes = entries.filter(({ source }) =>
		source.startsWith('/@:orgSlug/'),
	)
	expect(
		orgRoutes
			.filter(
				({ name, href }) =>
					!isOrgBoundPath(href) && !legacyOrgListRedirectRoutes.has(name),
			)
			.map((r) => r.name),
	).toEqual([])

	const accountRoutes = accountRoutesNamedLikeOrgSections(entries)
	const unclassified = accountRoutes
		.filter(
			({ name, href }) =>
				!isOrgBoundPath(href) && !(name in personScopedAccountRoutes),
		)
		.map(({ name }) => name)
	expect(unclassified).toEqual([])
	const accountRouteNames = new Set(accountRoutes.map(({ name }) => name))
	expect(
		Object.keys(personScopedAccountRoutes).filter(
			(name) => !accountRouteNames.has(name),
		),
	).toEqual([])
	expect(
		accountRoutes
			.filter(
				({ name, href }) =>
					name in personScopedAccountRoutes && isOrgBoundPath(href),
			)
			.map(({ name }) => name),
	).toEqual([])
})

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (1, 'ada', 'ada@example.com', 'x', ?)`,
		)
		.run(adaPersonId)
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	insertOrg.run(adaPersonId, 'ada', null, now, now)
	insertOrg.run('org-acme', 'acme', 'Acme', now, now)
	insertOrg.run('org-ghost', 'ghost', 'Ghost', now, now)
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'owner', ?)`,
	)
	insertMembership.run(adaPersonId, adaPersonId, now)
	insertMembership.run('org-acme', adaPersonId, now)
	return {
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			COOKIE_SECRET: cookieSecret,
		} as unknown as Env,
		sqlite,
	}
}

async function adaCookie() {
	setAuthSessionSecret(cookieSecret)
	return createAuthCookie(
		{
			stableUserId: adaPersonId,
			email: 'ada@example.com',
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)
}

function methodsFor(method: string) {
	return method === 'ANY' ? ['GET', 'POST'] : [method]
}

/** `/@ghost/-/…`, or account JSON fetched from a `/@ghost/-/<section>` page. */
function deniedRequest(entry: RouteEntry, method: string, cookie: string) {
	const url = new URL(entry.href, origin)
	const headers = new Headers({ Cookie: cookie })
	if (url.pathname.startsWith('/account/')) {
		const section =
			/^\/account\/([^/.]+)/
				.exec(url.pathname)?.[1]
				?.replace(/^(connected-agents|connection-usage)$/, 'connections') ?? ''
		headers.set(
			'Referer',
			`${origin}/@ghost/-/${section.replace(/-export$/, '')}`,
		)
	}
	if (method !== 'GET') {
		headers.set('Origin', origin)
		headers.set('Sec-Fetch-Site', 'same-origin')
		headers.set('Content-Type', 'application/json')
	}
	return new Request(url, {
		method,
		headers,
		body: method === 'GET' ? undefined : '{}',
	})
}

test('every org-scoped route 404s for an org the person cannot use', async () => {
	const { env } = createEnv()
	const router = createAppRouter(env)
	const cookie = await adaCookie()
	const bound = orgBoundRoutes(routeEntries())
	expect(bound.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			'orgMemories',
			'orgWorkflows',
			'orgWebhooks',
			'orgMcpServers',
			'orgMcpServerAuthorizePost',
			'orgSettingsPost',
			'accountMemoriesApi',
			'accountMemoriesApiPost',
			'accountMemoriesExport',
			'accountWorkflowsApiPost',
			'accountWebhooksApi',
			'accountMcpServersApiPost',
			'accountSecretsApiPost',
			'accountJobsApiPost',
			'accountConnectedAgentsApiPost',
		]),
	)
	const failures: Array<string> = []
	for (const entry of bound) {
		for (const method of methodsFor(entry.method)) {
			const response = await router.fetch(deniedRequest(entry, method, cookie))
			if (response.status !== 404) {
				failures.push(
					`${entry.name} ${method} ${entry.href}: ${response.status}`,
				)
				continue
			}
			const pageLoad =
				method === 'GET' &&
				!new URL(entry.href, origin).pathname.endsWith('.json')
			if (!pageLoad) {
				const body = JSON.stringify(await response.json())
				if (body !== '{"ok":false,"error":"Organization not found."}') {
					failures.push(`${entry.name} ${method}: ${body}`)
				}
			}
		}
	}
	expect(failures).toEqual([])
})

test('the guard hands off to the route for orgs the person can use', async () => {
	const { env, sqlite } = createEnv()
	sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type,
			   subject_id, preset, created_by_user_id, created_at, updated_at)
			 VALUES ('grant-1', 'org-ghost', 'credential', 'secret-1', 'user', ?, 'use', 'org-ghost', ?, ?)`,
		)
		.run(adaPersonId, now, now)
	const guard = createOrgBindingGuardMiddleware(env)
	const cookie = await adaCookie()
	const run = async (path: string, referer?: string) => {
		const next = vi.fn(async () => new Response('route'))
		const request = new Request(`${origin}${path}`, {
			headers: { Cookie: cookie, ...(referer ? { Referer: referer } : {}) },
		})
		const response = await guard(
			{ request, url: new URL(request.url) } as never,
			next,
		)
		return { status: response.status, reachedRoute: next.mock.calls.length }
	}
	const routed = { status: 200, reachedRoute: 1 }
	const notFound = { status: 404, reachedRoute: 0 }

	await expect(run('/@acme/-/memories')).resolves.toEqual(routed)
	await expect(
		run('/account/workflows.json', `${origin}/@acme/-/workflows`),
	).resolves.toEqual(routed)
	await expect(run('/account/memories.json')).resolves.toEqual(routed)
	await expect(run('/account/profile.json')).resolves.toEqual(routed)
	await expect(run('/@ghost')).resolves.toEqual(routed)
	// A grant opens the org (its pages apply their own section gate) and its
	// Connections data, not the rest of its account JSON.
	await expect(run('/@ghost/-/connections')).resolves.toEqual(routed)
	await expect(
		run('/account/connected-agents.json', `${origin}/@ghost/-/connections`),
	).resolves.toEqual(routed)
	await expect(
		run('/account/webhooks.json', `${origin}/@ghost/-/connections`),
	).resolves.toEqual(notFound)
	await expect(run('/@nobody/-/memories')).resolves.toEqual(notFound)
})

test('signed-out requests reach the route for its own login handling', async () => {
	const { env } = createEnv()
	const guard = createOrgBindingGuardMiddleware(env)
	const next = vi.fn(async () => new Response('route'))
	const request = new Request(`${origin}/@ghost/-/memories`)
	const response = await guard(
		{ request, url: new URL(request.url) } as never,
		next,
	)
	expect(response.status).toBe(200)
	expect(next).toHaveBeenCalledOnce()
})

test('org-bound account JSON responses remember the Referer org as last-used', async () => {
	const { env } = createEnv()
	const guard = createOrgBindingGuardMiddleware(env)
	const cookie = await adaCookie()
	const next = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
	const request = new Request(`${origin}/account/secrets.json`, {
		headers: {
			Cookie: cookie,
			Referer: `${origin}/@acme/-/secrets`,
		},
	})
	const response = await guard(
		{ request, url: new URL(request.url) } as never,
		next,
	)
	expect(response.status).toBe(200)
	expect(next).toHaveBeenCalledOnce()
	expect(response.headers.getSetCookie()).toEqual([
		expect.stringMatching(/^kody_last_org=acme;/),
	])
})

test('prefetch account JSON does not set the last-used cookie', async () => {
	const { env } = createEnv()
	const guard = createOrgBindingGuardMiddleware(env)
	const cookie = await adaCookie()
	const next = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
	const request = new Request(`${origin}/account/secrets.json`, {
		headers: {
			Cookie: cookie,
			Referer: `${origin}/@acme/-/secrets`,
			'X-Kody-Prefetch': '1',
		},
	})
	const response = await guard(
		{ request, url: new URL(request.url) } as never,
		next,
	)
	expect(response.status).toBe(200)
	expect(response.headers.getSetCookie()).toEqual([])
})

test('org management JSON remembers the path org as last-used', async () => {
	const { env } = createEnv()
	const guard = createOrgBindingGuardMiddleware(env)
	const cookie = await adaCookie()
	const next = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
	const request = new Request(`${origin}/@acme/-/settings.json`, {
		headers: { Cookie: cookie },
	})
	const response = await guard(
		{ request, url: new URL(request.url) } as never,
		next,
	)
	expect(response.status).toBe(200)
	expect(response.headers.getSetCookie()).toEqual([
		expect.stringMatching(/^kody_last_org=acme;/),
	])
})

test('account JSON without an org Referer does not set the last-used cookie', async () => {
	const { env } = createEnv()
	const guard = createOrgBindingGuardMiddleware(env)
	const cookie = await adaCookie()
	const next = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
	const request = new Request(`${origin}/account/secrets.json`, {
		headers: { Cookie: cookie },
	})
	const response = await guard(
		{ request, url: new URL(request.url) } as never,
		next,
	)
	expect(response.status).toBe(200)
	expect(response.headers.getSetCookie()).toEqual([])
})

test('org page paths do not duplicate the last-used cookie in the guard', async () => {
	const { env } = createEnv()
	const guard = createOrgBindingGuardMiddleware(env)
	const cookie = await adaCookie()
	const next = vi.fn(async () => new Response('page'))
	const request = new Request(`${origin}/@acme/-/secrets`, {
		headers: { Cookie: cookie },
	})
	const response = await guard(
		{ request, url: new URL(request.url) } as never,
		next,
	)
	expect(response.status).toBe(200)
	expect(response.headers.getSetCookie()).toEqual([])
})
