/**
 * Per-evaluate host counters for Durable Object reset retry.
 *
 * LOADER requires a real Fetcher for `globalOutbound`, so we cannot wrap
 * outbound fetch on the host. Fetch attempts are recorded through this
 * evaluate's RPC dispatcher *before* the sandbox calls native fetch.
 * Dispatcher attempts increment before `await` so a reset mid-call still
 * counts.
 */

export const hostSideEffectProviderName = '__kodyHostSideEffects'

export const staticCallMeterRuntimeBridgeProviderName =
	'__kodyStaticCallMeterRuntimeBridge'

const platformOnlyHostSideEffectProviderNames = new Set([
	hostSideEffectProviderName,
	staticCallMeterRuntimeBridgeProviderName,
])

export type EvaluationHostSideEffects = {
	dispatcherAttempts: number
	fetchAttempts: number
}

export type EvaluationSideEffectTracker = {
	recordDispatcherAttempt: () => void
	recordFetchAttempt: () => void
	snapshot: () => EvaluationHostSideEffects
}

export function isPlatformOnlyHostSideEffectProvider(providerName: string) {
	return platformOnlyHostSideEffectProviderNames.has(providerName)
}

export function createEvaluationSideEffectTracker(): EvaluationSideEffectTracker {
	let dispatcherAttempts = 0
	let fetchAttempts = 0
	return {
		recordDispatcherAttempt() {
			dispatcherAttempts += 1
		},
		recordFetchAttempt() {
			fetchAttempts += 1
		},
		snapshot() {
			return { dispatcherAttempts, fetchAttempts }
		},
	}
}

export function createHostSideEffectProvider(
	sideEffects: EvaluationSideEffectTracker,
) {
	return {
		name: hostSideEffectProviderName,
		fns: {
			recordFetch: async () => {
				sideEffects.recordFetchAttempt()
			},
		},
	}
}

/**
 * Missing snapshot is treated as dirty: a thrown evaluate that never
 * attached host counters is "unknown side effects," not a clean retry.
 */
export function evaluationHasHostMediatedSideEffects(
	sideEffects: EvaluationHostSideEffects | null | undefined,
) {
	if (sideEffects == null) return true
	return sideEffects.dispatcherAttempts > 0 || sideEffects.fetchAttempts > 0
}
