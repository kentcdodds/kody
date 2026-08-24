import {
	continuePublicCodeRunsWindow,
	isStillPublicCodeRunsWindow,
	parsePublicCodeRunsWindow,
	publicCodeRunsWindowMs,
	stillPublicCodeRunsWindow,
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
	if (stored.status === 'failed') return null
	if (stored.status === 'found') {
		const window = stored.window
		const endMs = Date.parse(window.windowEnd)
		const expired = Number.isFinite(endMs) && now.getTime() >= endMs
		if (!expired && !isStillPublicCodeRunsWindow(window)) return window
		const total = await sumExecuteEventCount(env)
		if (total === null || total <= 0) return window
		return (
			continuePublicCodeRunsWindow({ stored: window, total, now }) ?? window
		)
	}
	const total = await sumExecuteEventCount(env)
	if (total === null || total <= 0) return null
	return stillPublicCodeRunsWindow(total, now)
}

export async function refreshPublicCodeRunsWindow(input: {
	env: CodeRunsWindowEnv
	now?: Date
}): Promise<
	| { status: 'initialized' | 'rotated' | 'held' }
	| {
			status: 'skipped'
			reason: 'no_kv' | 'no_runs' | 'query_failed' | 'kv_read_failed'
	  }
> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return { status: 'skipped', reason: 'no_kv' }
	const now = input.now ?? new Date()
	try {
		const total = await sumExecuteEventCount(input.env)
		if (total === null) return { status: 'skipped', reason: 'query_failed' }
		if (total <= 0) return { status: 'skipped', reason: 'no_runs' }

		const existing = await readStoredWindow(input.env)
		if (existing.status === 'failed') {
			return { status: 'skipped', reason: 'kv_read_failed' }
		}
		if (existing.status === 'missing') {
			await writeStoredWindow(kv, stillPublicCodeRunsWindow(total, now))
			return { status: 'initialized' }
		}
		const existingWindow = existing.window
		const still = isStillPublicCodeRunsWindow(existingWindow)
		const windowEndMs = Date.parse(existingWindow.windowEnd)
		const beforeEnd =
			Number.isFinite(windowEndMs) && now.getTime() < windowEndMs
		const stillGrowing = still && total > existingWindow.current
		const stillRegressed = still && total < existingWindow.current
		// A still pair is a bootstrap (KV miss or first write). Holding it
		// for 24h freezes the homepage ticker even while executes accrue,
		// and `current = max(total, previous)` latches a stale high-water
		// mark when the fleet SUM later drops (authoritative AE recompute).
		// Live windows still hold until windowEnd so interpolation stays
		// deterministic for every visitor.
		if (beforeEnd && !stillGrowing && !stillRegressed) {
			return { status: 'held' }
		}
		if (total <= existingWindow.current) {
			await writeStoredWindow(kv, stillPublicCodeRunsWindow(total, now))
			return { status: 'rotated' }
		}

		await writeStoredWindow(kv, {
			previous: existingWindow.current,
			current: total,
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
): Promise<
	| { status: 'found'; window: PublicCodeRunsWindow }
	| { status: 'missing' }
	| { status: 'failed' }
> {
	const kv = env.BUNDLE_ARTIFACTS_KV
	if (!kv) return { status: 'missing' }
	try {
		const window = parsePublicCodeRunsWindow(
			await kv.get(publicCodeRunsKvKey, 'json'),
		)
		return window ? { status: 'found', window } : { status: 'missing' }
	} catch (error) {
		console.debug('public-code-runs-window-read-failed', error)
		return { status: 'failed' }
	}
}

async function writeStoredWindow(
	kv: KVNamespace,
	window: PublicCodeRunsWindow,
) {
	await kv.put(publicCodeRunsKvKey, JSON.stringify(window))
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
		).first<{ total: unknown }>()
		return toNonNegativeCount(row?.total)
	} catch (error) {
		console.debug('public-code-runs-sum-failed', error)
		return null
	}
}

/**
 * D1 `SUM` / `COALESCE` can arrive as a number, numeric string, or bigint.
 * Treating anything but `typeof === 'number'` as zero froze the homepage
 * ticker on a still pair even while execute rollups existed.
 */
function toNonNegativeCount(value: unknown): number {
	if (typeof value === 'bigint') {
		if (value < 0n) return 0
		const parsed = Number(value)
		return Number.isFinite(parsed) ? Math.floor(parsed) : 0
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0) return 0
	return Math.floor(parsed)
}
