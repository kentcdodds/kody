import { expect, test } from 'vitest'
import { jobsProbeOrigin, runAllProbes } from './probes.ts'
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

const primaryOrigin = 'https://kody.codes'
const packageAppOrigin = 'https://kody.run'
const runtimeHealth = `${packageAppOrigin}/__runtime/health`
const jobsHealth = `${jobsProbeOrigin}/health`
const jobsComponents = `${jobsProbeOrigin}/health/components`

function healthyRoutes(): Record<string, FakeRoute> {
	return {
		[`${primaryOrigin}/health`]: {
			body: { ok: true, commitSha: 'abc123def4567890abcdef1234567890abcdef12' },
		},
		[`${primaryOrigin}/mcp`]: {
			status: 401,
			headers: { 'WWW-Authenticate': 'Bearer resource_metadata="..."' },
		},
		[runtimeHealth]: {
			body: {
				status: 'ok',
				commitSha: 'def4567890abcdef1234567890abcdef12345678',
				cookieSecretConfigured: true,
			},
		},
		[jobsHealth]: {
			body: { ok: true, commit: '7890abcdef1234567890abcdef1234567890abcd' },
		},
		[jobsComponents]: {
			body: {
				ok: true,
				commit: '7890abcdef1234567890abcdef1234567890abcd',
				components: [{ id: 'jobs_db', ok: true, latencyMs: 3 }],
			},
		},
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
	result: Awaited<ReturnType<typeof runAllProbes>>,
	component: string,
) {
	return result.outcomes.find((entry) => entry.component === component)
}

test('a fully healthy pass reports every component ok', async () => {
	const result = await probe(healthyRoutes())
	expect(result.outcomes.map((entry) => entry.component).toSorted()).toEqual(
		[...statusComponentIds].toSorted(),
	)
	for (const entry of result.outcomes) {
		expect(entry.ok, `${entry.component} should be ok`).toBe(true)
	}
	expect(outcome(result, 'app_db')?.latencyMs).toBe(4)
	expect(result.productionCommitSha).toBe(
		'abc123def4567890abcdef1234567890abcdef12',
	)
	expect(result.runtimeCommitSha).toBe(
		'def4567890abcdef1234567890abcdef12345678',
	)
	expect(result.jobsCommitSha).toBe('7890abcdef1234567890abcdef1234567890abcd')
})

test('apex 302 is not package-runtime up; jobs probe failure is not app-down', async () => {
	const requested: Array<string> = []
	const apexRedirect = healthyRoutes()
	apexRedirect[`${packageAppOrigin}/`] = {
		status: 302,
		headers: { Location: 'https://kody.codes/' },
	}
	const apexFetcher = fakeFetcher(apexRedirect)
	const trackingFetcher: typeof fetch = (async (input, init) => {
		requested.push(typeof input === 'string' ? input : input.toString())
		return apexFetcher(input, init)
	}) as typeof fetch
	const apexResult = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: trackingFetcher,
	})
	expect(requested).not.toContain(`${packageAppOrigin}/`)
	expect(requested).toContain(runtimeHealth)
	expect(outcome(apexResult, 'package_apps')?.ok).toBe(true)

	const runtimeRedirect = healthyRoutes()
	runtimeRedirect[runtimeHealth] = {
		status: 302,
		headers: { Location: 'https://kody.codes/' },
	}
	const runtimeRedirectOutcomes = await probe(runtimeRedirect)
	expect(outcome(runtimeRedirectOutcomes, 'package_apps')).toMatchObject({
		ok: false,
		detail: 'HTTP 302',
	})
	expect(runtimeRedirectOutcomes.runtimeCommitSha).toBeNull()
	expect(outcome(runtimeRedirectOutcomes, 'app')?.ok).toBe(true)

	const runtimeHtml = healthyRoutes()
	runtimeHtml[runtimeHealth] = { status: 200, body: { ok: true } }
	expect(outcome(await probe(runtimeHtml), 'package_apps')).toMatchObject({
		ok: false,
		detail: 'HTTP 200',
	})

	const jobsDown = healthyRoutes()
	jobsDown[jobsHealth] = { error: 'jobs worker unreachable' }
	jobsDown[jobsComponents] = { error: 'jobs worker unreachable' }
	const jobsDownOutcomes = await probe(jobsDown)
	expect(outcome(jobsDownOutcomes, 'jobs')).toMatchObject({
		ok: false,
		detail: 'jobs worker unreachable',
	})
	expect(outcome(jobsDownOutcomes, 'app')?.ok).toBe(true)
	expect(outcome(jobsDownOutcomes, 'mcp')?.ok).toBe(true)
	expect(outcome(jobsDownOutcomes, 'package_apps')?.ok).toBe(true)

	const jobsDbDown = healthyRoutes()
	jobsDbDown[jobsComponents] = {
		status: 503,
		body: {
			ok: false,
			components: [{ id: 'jobs_db', ok: false, error: 'timeout' }],
		},
	}
	const jobsDbOutcomes = await probe(jobsDbDown)
	expect(outcome(jobsDbOutcomes, 'jobs')).toMatchObject({
		ok: false,
		detail: 'timeout',
	})
	expect(outcome(jobsDbOutcomes, 'app')?.ok).toBe(true)
	expect(jobsDbOutcomes.jobsCommitSha).toBe(
		'7890abcdef1234567890abcdef1234567890abcd',
	)
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
	expect(outcome(unreachableOutcomes, 'jobs')?.ok).toBe(true)

	for (const status of [521, 404]) {
		const packageRuntime = healthyRoutes()
		packageRuntime[runtimeHealth] = { status }
		expect(outcome(await probe(packageRuntime), 'package_apps')).toMatchObject({
			ok: false,
			detail: `HTTP ${String(status)}`,
		})
	}
})
