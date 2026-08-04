import { expect, test } from 'vitest'
import { runAllProbes } from './probes.ts'
import { statusComponentIds } from './status-types.ts'

type FakeRoute = {
	status?: number
	headers?: Record<string, string>
	body?: unknown
	error?: string
}

function fakeFetcher(routes: Record<string, FakeRoute>): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		const route = routes[url]
		if (!route) throw new Error(`Unexpected probe URL: ${url}`)
		if (route.error) throw new Error(route.error)
		return new Response(
			route.body === undefined ? null : JSON.stringify(route.body),
			{ status: route.status ?? 200, headers: route.headers ?? {} },
		)
	}) as typeof fetch
}

const primaryOrigin = 'https://heykody.dev'
const packageAppOrigin = 'https://kodyapps.dev'

function healthyRoutes(): Record<string, FakeRoute> {
	return {
		[`${primaryOrigin}/health`]: { body: { ok: true, commitSha: 'abc' } },
		[`${primaryOrigin}/mcp`]: {
			status: 401,
			headers: { 'WWW-Authenticate': 'Bearer resource_metadata="..."' },
		},
		[`${packageAppOrigin}/`]: { status: 302, headers: { Location: '/x' } },
		[`${primaryOrigin}/health/components`]: {
			body: {
				ok: true,
				components: [
					{ id: 'app_db', ok: true, latencyMs: 4 },
					{ id: 'audit_db', ok: true, latencyMs: 6 },
					{ id: 'kv', ok: true, latencyMs: 2 },
					{ id: 'assets', ok: true, latencyMs: 9 },
				],
			},
		},
	}
}

test('a fully healthy pass reports every component ok', async () => {
	const outcomes = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(healthyRoutes()),
	})
	expect(outcomes.map((outcome) => outcome.component).toSorted()).toEqual(
		[...statusComponentIds].toSorted(),
	)
	for (const outcome of outcomes) {
		expect(outcome.ok, `${outcome.component} should be ok`).toBe(true)
	}
	const appDb = outcomes.find((outcome) => outcome.component === 'app_db')
	expect(appDb?.latencyMs).toBe(4)
})

test('an mcp response without the oauth challenge fails the mcp probe only', async () => {
	const routes = healthyRoutes()
	routes[`${primaryOrigin}/mcp`] = { status: 500 }
	const outcomes = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
	const mcp = outcomes.find((outcome) => outcome.component === 'mcp')
	expect(mcp).toMatchObject({ ok: false, detail: 'HTTP 500' })
	const app = outcomes.find((outcome) => outcome.component === 'app')
	expect(app?.ok).toBe(true)
})

test('a 401 with a non-bearer challenge fails the mcp probe', async () => {
	const routes = healthyRoutes()
	routes[`${primaryOrigin}/mcp`] = {
		status: 401,
		headers: { 'WWW-Authenticate': 'Basic realm="nope"' },
	}
	const outcomes = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
	const mcp = outcomes.find((outcome) => outcome.component === 'mcp')
	expect(mcp).toMatchObject({ ok: false, detail: 'HTTP 401' })
})

test('a failing component in the components endpoint maps through', async () => {
	const routes = healthyRoutes()
	routes[`${primaryOrigin}/health/components`] = {
		status: 503,
		body: {
			ok: false,
			components: [
				{ id: 'app_db', ok: false, error: 'timeout' },
				{ id: 'audit_db', ok: true, latencyMs: 6 },
				{ id: 'kv', ok: true, latencyMs: 2 },
				{ id: 'assets', ok: true, latencyMs: 9 },
			],
		},
	}
	const outcomes = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
	const appDb = outcomes.find((outcome) => outcome.component === 'app_db')
	expect(appDb).toMatchObject({ ok: false, detail: 'timeout' })
	const auditDb = outcomes.find((outcome) => outcome.component === 'audit_db')
	expect(auditDb?.ok).toBe(true)
})

test('an unreachable main worker fails app and storage components', async () => {
	const routes = healthyRoutes()
	routes[`${primaryOrigin}/health`] = { error: 'connection refused' }
	routes[`${primaryOrigin}/health/components`] = {
		error: 'connection refused',
	}
	const outcomes = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
	const app = outcomes.find((outcome) => outcome.component === 'app')
	expect(app).toMatchObject({ ok: false, detail: 'connection refused' })
	const appDb = outcomes.find((outcome) => outcome.component === 'app_db')
	expect(appDb).toMatchObject({ ok: false, detail: 'unreachable' })
})

test('a package apps 5xx fails the package_apps probe', async () => {
	const routes = healthyRoutes()
	routes[`${packageAppOrigin}/`] = { status: 521 }
	const outcomes = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
	const packageApps = outcomes.find(
		(outcome) => outcome.component === 'package_apps',
	)
	expect(packageApps).toMatchObject({ ok: false, detail: 'HTTP 521' })
})

test('a package apps 404 fails the package_apps probe', async () => {
	const routes = healthyRoutes()
	routes[`${packageAppOrigin}/`] = { status: 404 }
	const outcomes = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
	const packageApps = outcomes.find(
		(outcome) => outcome.component === 'package_apps',
	)
	expect(packageApps).toMatchObject({ ok: false, detail: 'HTTP 404' })
})
