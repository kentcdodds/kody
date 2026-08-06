import { type Action } from 'remix/router'
import { type routes } from '#app/routes.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { type AppEnv } from '#worker/env-schema.ts'

/**
 * Component-level health used by the public status page prober
 * (`packages/status`). Each check is a cheap read against one storage binding,
 * so a failing component points at that subsystem rather than the worker as a
 * whole. Results are memoized briefly so public traffic cannot amplify load on
 * the underlying bindings.
 */

const componentCheckTimeoutMs = 3_000
const resultCacheTtlMs = 10_000

/**
 * Transient D1 blips (SQLITE_BUSY, "Network connection lost", opaque
 * "internal error; reference = …") are tolerated with retries on every
 * production D1 path, so a single blip must not register as component
 * downtime on the public status page — the mostly idle audit database was
 * losing uptime to exactly these. Three attempts with the standard backoff
 * (worst case ~450ms of sleep) stay well inside the 3s check timeout, so
 * sustained unavailability still fails the check.
 */
const d1CheckRetryOptions = { maxAttempts: 3 } as const

export const healthComponentIds = [
	'app_db',
	'audit_db',
	'kv',
	'assets',
] as const

export type HealthComponentId = (typeof healthComponentIds)[number]

export type HealthComponentResult = {
	id: HealthComponentId
	ok: boolean
	latencyMs: number
	error?: 'timeout' | 'unavailable' | 'error'
}

export type HealthComponentsReport = {
	ok: boolean
	commitSha: string | null
	checkedAt: string
	components: Array<HealthComponentResult>
}

type HealthComponentsEnv = {
	APP_COMMIT_SHA: AppEnv['APP_COMMIT_SHA']
	APP_DB?: D1Database
	AUDIT_DB?: D1Database
	OAUTH_KV?: KVNamespace
	COMMUNITY_ASSETS?: R2Bucket
}

async function runComponentCheck(
	id: HealthComponentId,
	check: (() => Promise<unknown>) | null,
): Promise<HealthComponentResult> {
	const startedAt = Date.now()
	if (!check) {
		return { id, ok: false, latencyMs: 0, error: 'unavailable' }
	}
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<'timeout'>((resolve) => {
		timeoutHandle = setTimeout(
			() => resolve('timeout'),
			componentCheckTimeoutMs,
		)
	})
	try {
		const outcome = await Promise.race([
			check().then(() => 'ok' as const),
			timeout,
		])
		const latencyMs = Date.now() - startedAt
		if (outcome === 'timeout') {
			console.warn('health-component-timeout', JSON.stringify({ id }))
			return { id, ok: false, latencyMs, error: 'timeout' }
		}
		return { id, ok: true, latencyMs }
	} catch (error) {
		const latencyMs = Date.now() - startedAt
		console.warn(
			'health-component-failed',
			JSON.stringify({
				id,
				message: error instanceof Error ? error.message : String(error),
			}),
		)
		return { id, ok: false, latencyMs, error: 'error' }
	} finally {
		clearTimeout(timeoutHandle)
	}
}

export async function collectHealthComponents(
	env: HealthComponentsEnv,
): Promise<HealthComponentsReport> {
	const appDb = env.APP_DB
	const auditDb = env.AUDIT_DB
	const oauthKv = env.OAUTH_KV
	const assets = env.COMMUNITY_ASSETS
	const components = await Promise.all([
		runComponentCheck(
			'app_db',
			appDb
				? () =>
						runD1WithRetry(
							() => appDb.prepare('SELECT 1').first(),
							d1CheckRetryOptions,
						)
				: null,
		),
		runComponentCheck(
			'audit_db',
			auditDb
				? () =>
						runD1WithRetry(
							() => auditDb.prepare('SELECT 1').first(),
							d1CheckRetryOptions,
						)
				: null,
		),
		runComponentCheck(
			'kv',
			oauthKv ? () => oauthKv.get('health-component-probe') : null,
		),
		runComponentCheck(
			'assets',
			assets ? () => assets.head('health-component-probe') : null,
		),
	])
	return {
		ok: components.every((component) => component.ok),
		commitSha: env.APP_COMMIT_SHA ?? null,
		checkedAt: new Date().toISOString(),
		components,
	}
}

export function createHealthComponentsHandler(appEnv: HealthComponentsEnv) {
	// Concurrent requests share one in-flight collection so public traffic at
	// cache expiry cannot fan out into parallel probes of the same bindings.
	let cached: { report: HealthComponentsReport; expiresAt: number } | null =
		null
	let inFlight: Promise<HealthComponentsReport> | null = null
	return {
		middleware: [],
		async handler() {
			const now = Date.now()
			let report: HealthComponentsReport
			if (cached && cached.expiresAt > now) {
				report = cached.report
			} else {
				if (!inFlight) {
					inFlight = collectHealthComponents(appEnv)
						.then((collected) => {
							cached = {
								report: collected,
								expiresAt: Date.now() + resultCacheTtlMs,
							}
							return collected
						})
						.finally(() => {
							inFlight = null
						})
				}
				report = await inFlight
			}
			return Response.json(report, {
				status: report.ok ? 200 : 503,
				headers: { 'Cache-Control': 'no-store' },
			})
		},
	} satisfies Action<typeof routes.healthComponents>
}
