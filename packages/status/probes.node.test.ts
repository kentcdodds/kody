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

async function probe(routes: Record<string, FakeRoute>) {
	return runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
}

function outcome(
	outcomes: Awaited<ReturnType<typeof runAllProbes>>,
	component: string,
) {
	return outcomes.find((entry) => entry.component === component)
}

test('a fully healthy pass reports every component ok', async () => {
	const outcomes = await probe(healthyRoutes())
	expect(outcomes.map((entry) => entry.component).toSorted()).toEqual(
		[...statusComponentIds].toSorted(),
	)
	for (const entry of outcomes) {
		expect(entry.ok, `${entry.component} should be ok`).toBe(true)
	}
	expect(outcome(outcomes, 'app_db')?.latencyMs).toBe(4)
})

test('probe failures isolate to the affected component and map error details', async () => {
	const mcpHttp = healthyRoutes()
	mcpHttp[`${primaryOrigin}/mcp`] = { status: 500 }
	expect(outcome(await probe(mcpHttp), 'mcp')).toMatchObject({
		ok: false,
		detail: 'HTTP 500',
	})
	expect(outcome(await probe(mcpHttp), 'app')?.ok).toBe(true)

	const mcpChallenge = healthyRoutes()
	mcpChallenge[`${primaryOrigin}/mcp`] = {
		status: 401,
		headers: { 'WWW-Authenticate': 'Basic realm="nope"' },
	}
	expect(outcome(await probe(mcpChallenge), 'mcp')).toMatchObject({
		ok: false,
		detail: 'HTTP 401',
	})

	const components = healthyRoutes()
	components[`${primaryOrigin}/health/components`] = {
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
	const componentOutcomes = await probe(components)
	expect(outcome(componentOutcomes, 'app_db')).toMatchObject({
		ok: false,
		detail: 'timeout',
	})
	expect(outcome(componentOutcomes, 'audit_db')?.ok).toBe(true)

	const unreachable = healthyRoutes()
	unreachable[`${primaryOrigin}/health`] = { error: 'connection refused' }
	unreachable[`${primaryOrigin}/health/components`] = {
		error: 'connection refused',
	}
	const unreachableOutcomes = await probe(unreachable)
	expect(outcome(unreachableOutcomes, 'app')).toMatchObject({
		ok: false,
		detail: 'connection refused',
	})
	expect(outcome(unreachableOutcomes, 'app_db')).toMatchObject({
		ok: false,
		detail: 'unreachable',
	})

	for (const status of [521, 404]) {
		const packageApps = healthyRoutes()
		packageApps[`${packageAppOrigin}/`] = { status }
		expect(outcome(await probe(packageApps), 'package_apps')).toMatchObject({
			ok: false,
			detail: `HTTP ${String(status)}`,
		})
	}
})
