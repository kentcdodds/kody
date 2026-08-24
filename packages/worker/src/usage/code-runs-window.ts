import {
	parsePublicCodeRunsWindow,
	publicCodeRunsWindowsEqual,
	type PublicCodeRunsWindow,
} from '#universal/code-runs.ts'
import { computeDelayedExecuteWindow } from './fleet-execute-days.ts'

export const publicCodeRunsKvKey = 'public-code-runs:v2'

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
	const cachedUntil =
		stored.status === 'found' ? Date.parse(stored.window.updateAt) : NaN
	if (stored.status === 'found' && now.getTime() < cachedUntil) {
		return stored.window
	}
	const computed = await computeWindow(env, now)
	if (computed && env.BUNDLE_ARTIFACTS_KV) {
		try {
			await writeStoredWindow(env.BUNDLE_ARTIFACTS_KV, computed)
		} catch (error) {
			console.debug('public-code-runs-window-write-failed', error)
		}
	}
	return computed
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
		if (!input.env.APP_DB) return { status: 'skipped', reason: 'query_failed' }
		const computed = await computeDelayedExecuteWindow(input.env.APP_DB, now)
		const existing = await readStoredWindow(input.env)
		if (existing.status === 'failed') {
			return { status: 'skipped', reason: 'kv_read_failed' }
		}
		if (!computed) {
			if (existing.status === 'found') {
				try {
					await kv.delete(publicCodeRunsKvKey)
				} catch (error) {
					console.debug('public-code-runs-window-delete-failed', error)
				}
			}
			return { status: 'skipped', reason: 'no_runs' }
		}
		if (
			existing.status === 'found' &&
			publicCodeRunsWindowsEqual(existing.window, computed) &&
			now.getTime() < Date.parse(computed.updateAt)
		) {
			return { status: 'held' }
		}
		await writeStoredWindow(kv, computed)
		return {
			status: existing.status === 'missing' ? 'initialized' : 'rotated',
		}
	} catch (error) {
		console.warn('public-code-runs-window-refresh-failed', error)
		return { status: 'skipped', reason: 'query_failed' }
	}
}

async function computeWindow(
	env: CodeRunsWindowEnv,
	now: Date,
): Promise<PublicCodeRunsWindow | null> {
	if (!env.APP_DB) return null
	return computeDelayedExecuteWindow(env.APP_DB, now)
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
