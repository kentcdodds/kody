import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	recordUsage,
	type DynamicWorkerCacheReuse,
	type UsageEnv,
	type UsageOutcome,
} from '#worker/usage/record-usage.ts'
import { type DynamicWorkerDaySurface } from './dynamic-worker-day-surface.ts'
import { type ExecuteThinGlueClass } from './execute-thin-glue.ts'

const workerModuleTextKeys = ['js', 'cjs', 'text'] as const

/**
 * Character length of the module-graph text that participates in the
 * Dynamic Worker id. Counts string modules and `js` / `cjs` / `text`
 * fields only — never names, params, or binary payloads.
 */
export function countDynamicWorkerModuleGraphChars(
	modules: WorkerLoaderModules,
): number {
	let total = 0
	for (const moduleValue of Object.values(modules)) {
		if (typeof moduleValue === 'string') {
			total += moduleValue.length
			continue
		}
		if (moduleValue === null || typeof moduleValue !== 'object') continue
		const record = moduleValue as Record<string, unknown>
		for (const key of workerModuleTextKeys) {
			const value = record[key]
			if (typeof value === 'string') total += value.length
		}
	}
	return total
}

/**
 * Record one observe-only `dynamic_worker_invoke` for a LOADER evaluate.
 * Hits and misses both write. Payload is numbers and closed enums only.
 *
 * Never throws.
 */
export async function recordDynamicWorkerInvoke(input: {
	env: UsageEnv
	userId: string | null | undefined
	durationMs: number
	outcome: UsageOutcome
	surface: DynamicWorkerDaySurface
	cacheReuse: DynamicWorkerCacheReuse
	codeChars: number
	executeShape?: ExecuteThinGlueClass | null
	hadParams?: boolean
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<void> {
	try {
		if (!input.userId) return
		await recordUsage(
			input.env,
			{
				userId: input.userId,
				eventType: 'dynamic_worker_invoke',
				durationMs: input.durationMs,
				outcome: input.outcome,
				surface: input.surface,
				cacheReuse: input.cacheReuse,
				codeChars: input.codeChars,
				...(input.hadParams != null ? { hadParams: input.hadParams } : {}),
				...(input.executeShape ? { executeShape: input.executeShape } : {}),
			},
			{ waitUntil: input.waitUntil },
		)
	} catch (error) {
		console.warn('dynamic-worker-invoke-record-failed', error)
	}
}
