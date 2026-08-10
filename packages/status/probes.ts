import {
	statusComponentIds,
	type ProbeOutcome,
	type StatusComponentId,
} from './status-types.ts'

/**
 * Active probes the status worker runs against public endpoints every
 * scheduled tick. Direct probes cover the worker surfaces (app, MCP, package
 * apps); the `/health/components` endpoint on the main worker reports the
 * storage bindings (D1, KV, R2) it depends on.
 */

const probeTimeoutMs = 10_000

type ProbeConfig = {
	primaryOrigin: string
	packageAppOrigin: string
	fetcher?: typeof fetch
}

type HealthComponentsBody = {
	components?: Array<{
		id?: string
		ok?: boolean
		latencyMs?: number
		error?: string
	}>
}

const componentEndpointIds = [
	'app_db',
	'audit_db',
	'kv',
	'assets',
] as const satisfies ReadonlyArray<StatusComponentId>

function truncateDetail(detail: string): string {
	return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
}

async function timedFetch(
	fetcher: typeof fetch,
	url: string,
): Promise<
	| { response: Response; latencyMs: number }
	| { response: null; latencyMs: number; error: string }
> {
	const startedAt = Date.now()
	try {
		const response = await fetcher(url, {
			redirect: 'manual',
			signal: AbortSignal.timeout(probeTimeoutMs),
			headers: { 'User-Agent': 'kody-status-prober' },
		})
		return { response, latencyMs: Date.now() - startedAt }
	} catch (error) {
		return {
			response: null,
			latencyMs: Date.now() - startedAt,
			error: truncateDetail(
				error instanceof Error ? error.message : String(error),
			),
		}
	}
}

type AppHealthBody = {
	ok?: boolean
	commitSha?: string
}

function readProductionCommitSha(body: AppHealthBody | null): string | null {
	const commitSha = body?.commitSha?.trim()
	if (!commitSha || !/^[0-9a-f]{7,40}$/i.test(commitSha)) return null
	return commitSha.toLowerCase()
}

async function probeApp(
	fetcher: typeof fetch,
	primaryOrigin: string,
): Promise<{ outcome: ProbeOutcome; productionCommitSha: string | null }> {
	const result = await timedFetch(fetcher, `${primaryOrigin}/health`)
	if (!result.response) {
		return {
			outcome: {
				component: 'app',
				ok: false,
				latencyMs: result.latencyMs,
				detail: result.error,
			},
			productionCommitSha: null,
		}
	}
	let body: AppHealthBody | null = null
	let bodyOk = false
	try {
		body = (await result.response.json()) as AppHealthBody
		bodyOk = body.ok === true
	} catch {
		body = null
		bodyOk = false
	}
	const ok = result.response.ok && bodyOk
	return {
		outcome: {
			component: 'app',
			ok,
			latencyMs: result.latencyMs,
			detail: ok ? null : `HTTP ${result.response.status}`,
		},
		productionCommitSha: readProductionCommitSha(body),
	}
}

async function probeMcp(
	fetcher: typeof fetch,
	primaryOrigin: string,
): Promise<ProbeOutcome> {
	const result = await timedFetch(fetcher, `${primaryOrigin}/mcp`)
	if (!result.response) {
		return {
			component: 'mcp',
			ok: false,
			latencyMs: result.latencyMs,
			detail: result.error,
		}
	}
	// An unauthenticated GET must produce the OAuth bearer challenge; anything
	// else (a 5xx, or a 401 with the wrong scheme) means the MCP surface is
	// broken.
	const challenge = result.response.headers.get('WWW-Authenticate') ?? ''
	const ok = result.response.status === 401 && challenge.startsWith('Bearer')
	return {
		component: 'mcp',
		ok,
		latencyMs: result.latencyMs,
		detail: ok ? null : `HTTP ${result.response.status}`,
	}
}

async function probePackageApps(
	fetcher: typeof fetch,
	packageAppOrigin: string,
): Promise<ProbeOutcome> {
	const result = await timedFetch(fetcher, `${packageAppOrigin}/`)
	if (!result.response) {
		return {
			component: 'package_apps',
			ok: false,
			latencyMs: result.latencyMs,
			detail: result.error,
		}
	}
	const ok = result.response.status >= 200 && result.response.status < 400
	return {
		component: 'package_apps',
		ok,
		latencyMs: result.latencyMs,
		detail: ok ? null : `HTTP ${result.response.status}`,
	}
}

async function probeStorageComponents(
	fetcher: typeof fetch,
	primaryOrigin: string,
): Promise<Array<ProbeOutcome>> {
	const result = await timedFetch(fetcher, `${primaryOrigin}/health/components`)
	if (!result.response) {
		return componentEndpointIds.map((component) => ({
			component,
			ok: false,
			latencyMs: null,
			detail: 'unreachable',
		}))
	}
	let body: HealthComponentsBody | null = null
	try {
		body = (await result.response.json()) as HealthComponentsBody
	} catch {
		body = null
	}
	if (!body || !Array.isArray(body.components)) {
		return componentEndpointIds.map((component) => ({
			component,
			ok: false,
			latencyMs: null,
			detail: `HTTP ${result.response.status}`,
		}))
	}
	return componentEndpointIds.map((component) => {
		const reported = body.components?.find((entry) => entry.id === component)
		if (!reported) {
			return { component, ok: false, latencyMs: null, detail: 'unreported' }
		}
		return {
			component,
			ok: reported.ok === true,
			latencyMs:
				typeof reported.latencyMs === 'number' ? reported.latencyMs : null,
			detail: reported.ok === true ? null : (reported.error ?? 'error'),
		}
	})
}

export type ProbeRunResult = {
	outcomes: Array<ProbeOutcome>
	productionCommitSha: string | null
}

export async function runAllProbes(
	config: ProbeConfig,
): Promise<ProbeRunResult> {
	const fetcher = config.fetcher ?? fetch
	const [app, mcp, packageApps, storage] = await Promise.all([
		probeApp(fetcher, config.primaryOrigin),
		probeMcp(fetcher, config.primaryOrigin),
		probePackageApps(fetcher, config.packageAppOrigin),
		probeStorageComponents(fetcher, config.primaryOrigin),
	])
	const outcomes = [app.outcome, mcp, packageApps, ...storage]
	const covered = new Set(outcomes.map((outcome) => outcome.component))
	for (const component of statusComponentIds) {
		if (!covered.has(component)) {
			outcomes.push({
				component,
				ok: false,
				latencyMs: null,
				detail: 'unprobed',
			})
		}
	}
	return { outcomes, productionCommitSha: app.productionCommitSha }
}
