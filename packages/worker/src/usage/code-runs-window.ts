import {
	parsePublicCodeRunsWindow,
	publicCodeRunsWindowMs,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'

export const publicCodeRunsKvKey = 'public-code-runs:v1'

type CodeRunsWindowEnv = {
	APP_DB?: D1Database
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export async function loadPublicCodeRunsWindow(
	env: CodeRunsWindowEnv,
	now: Date = new Date(),
): Promise<PublicCodeRunsWindow | null> {
	const stored = await readStoredWindow(env)
	if (stored) return stored
	const total = await sumExecuteEventCount(env)
	if (total === null || total <= 0) return null
	return stillWindow(total, now)
}

export async function refreshPublicCodeRunsWindow(input: {
	env: CodeRunsWindowEnv
	now?: Date
}): Promise<
	| { status: 'initialized' | 'rotated' | 'held' }
	| { status: 'skipped'; reason: 'no_kv' | 'no_runs' | 'query_failed' }
> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return { status: 'skipped', reason: 'no_kv' }
	const now = input.now ?? new Date()
	try {
		const total = await sumExecuteEventCount(input.env)
		if (total === null) return { status: 'skipped', reason: 'query_failed' }
		if (total <= 0) return { status: 'skipped', reason: 'no_runs' }

		const existing = await readStoredWindow(input.env)
		if (!existing) {
			await writeStoredWindow(kv, stillWindow(total, now))
			return { status: 'initialized' }
		}

		const windowEndMs = Date.parse(existing.windowEnd)
		if (Number.isFinite(windowEndMs) && now.getTime() < windowEndMs) {
			return { status: 'held' }
		}

		const previous = existing.current
		const current = Math.max(total, previous)
		await writeStoredWindow(kv, {
			previous,
			current,
			windowStart: now.toISOString(),
			windowEnd: new Date(now.getTime() + publicCodeRunsWindowMs).toISOString(),
		})
		return { status: 'rotated' }
	} catch (error) {
		console.warn('public-code-runs-window-refresh-failed', error)
		return { status: 'skipped', reason: 'query_failed' }
	}
}

async function readStoredWindow(
	env: CodeRunsWindowEnv,
): Promise<PublicCodeRunsWindow | null> {
	const kv = env.BUNDLE_ARTIFACTS_KV
	if (!kv) return null
	try {
		return parsePublicCodeRunsWindow(await kv.get(publicCodeRunsKvKey, 'json'))
	} catch (error) {
		console.debug('public-code-runs-window-read-failed', error)
		return null
	}
}

async function writeStoredWindow(
	kv: KVNamespace,
	window: PublicCodeRunsWindow,
) {
	await kv.put(publicCodeRunsKvKey, JSON.stringify(window))
}

function stillWindow(total: number, now: Date): PublicCodeRunsWindow {
	return {
		previous: total,
		current: total,
		windowStart: now.toISOString(),
		windowEnd: new Date(now.getTime() + publicCodeRunsWindowMs).toISOString(),
	}
}

async function sumExecuteEventCount(
	env: CodeRunsWindowEnv,
): Promise<number | null> {
	if (!env.APP_DB) return null
	try {
		const row = await env.APP_DB.prepare(
			`SELECT COALESCE(SUM(event_count), 0) AS total
			 FROM usage_rollups
			 WHERE metric = 'execute'`,
		).first<{ total: number }>()
		const total = row?.total
		if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
			return 0
		}
		return Math.floor(total)
	} catch (error) {
		console.debug('public-code-runs-sum-failed', error)
		return null
	}
}
