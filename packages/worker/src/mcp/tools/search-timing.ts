import { type SearchPhaseTimings } from './search-types.ts'

export function elapsedMs(startedAt: number): number {
	return Math.max(0, Math.round(performance.now() - startedAt))
}

/**
 * Exclusive tiles that partition search wall clock. Overlapping detail
 * phases (memory, retrievers, candidate plugins) are published beside
 * these and must not be summed into `exclusiveMs`.
 */
export const searchExclusivePhaseKeys = [
	'usernameLookupMs',
	'identityResolutionMs',
	'loadAndRankMs',
	'entityResolveMs',
	'firstSearchStampMs',
	'onboardingNoticeMs',
	'waitingItemsMs',
	'formattingMs',
] as const satisfies ReadonlyArray<keyof SearchPhaseTimings>

export function reconcileSearchPhaseTimings<
	T extends Partial<SearchPhaseTimings>,
>(input: {
	durationMs: number
	phaseTimings: T
}): T & Pick<SearchPhaseTimings, 'exclusiveMs' | 'unaccountedMs'> {
	let exclusiveMs = 0
	for (const key of searchExclusivePhaseKeys) {
		const value = input.phaseTimings[key]
		if (typeof value === 'number') exclusiveMs += value
	}
	// List mode folds registry load into `loadAndRankMs`. Entity lookups
	// have no load-and-rank wave, so the registry read is its own tile.
	if (
		typeof input.phaseTimings.loadAndRankMs !== 'number' &&
		typeof input.phaseTimings.rowAndRegistryLoadMs === 'number'
	) {
		exclusiveMs += input.phaseTimings.rowAndRegistryLoadMs
	}
	return {
		...input.phaseTimings,
		exclusiveMs,
		unaccountedMs: Math.max(0, input.durationMs - exclusiveMs),
	}
}

export async function settleWithBudget<T>(
	promise: Promise<T>,
	budgetMs: number,
	launchedAtMs: number = performance.now(),
): Promise<
	| { ok: true; value: T; durationMs: number; timedOut: false; failed: false }
	| {
			ok: false
			value: null
			durationMs: number
			timedOut: true
			failed: false
	  }
	| {
			ok: false
			value: null
			durationMs: number
			timedOut: false
			failed: true
			error: unknown
	  }
> {
	const remainingMs = Math.max(0, budgetMs - (performance.now() - launchedAtMs))
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		const raced = await Promise.race([
			promise.then(
				(value) => ({ status: 'fulfilled' as const, value }) as const,
				(error: unknown) => ({ status: 'rejected' as const, error }) as const,
			),
			new Promise<{ status: 'timeout' }>((resolve) => {
				timeoutId = setTimeout(() => {
					resolve({ status: 'timeout' })
				}, remainingMs)
			}),
		])
		const durationMs = elapsedMs(launchedAtMs)
		if (raced.status === 'timeout') {
			return {
				ok: false,
				value: null,
				durationMs,
				timedOut: true,
				failed: false,
			}
		}
		if (raced.status === 'rejected') {
			return {
				ok: false,
				value: null,
				durationMs,
				timedOut: false,
				failed: true,
				error: raced.error,
			}
		}
		return {
			ok: true,
			value: raced.value,
			durationMs,
			timedOut: false,
			failed: false,
		}
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}
