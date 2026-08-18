import { expect, test } from 'vitest'
import {
	createEvaluationSideEffectTracker,
	createHostSideEffectProvider,
	evaluationHasHostMediatedSideEffects,
	hostSideEffectProviderName,
	isPlatformOnlyHostSideEffectProvider,
	staticCallMeterRuntimeBridgeProviderName,
} from './evaluation-side-effects.ts'

test('evaluation side-effect tracker counts attempts and treats a missing snapshot as dirty', () => {
	expect(evaluationHasHostMediatedSideEffects(undefined)).toBe(true)
	expect(evaluationHasHostMediatedSideEffects(null)).toBe(true)
	expect(
		evaluationHasHostMediatedSideEffects({
			dispatcherAttempts: 0,
			fetchAttempts: 0,
		}),
	).toBe(false)

	const sideEffects = createEvaluationSideEffectTracker()
	expect(evaluationHasHostMediatedSideEffects(sideEffects.snapshot())).toBe(
		false,
	)
	sideEffects.recordDispatcherAttempt()
	expect(sideEffects.snapshot()).toEqual({
		dispatcherAttempts: 1,
		fetchAttempts: 0,
	})
	expect(evaluationHasHostMediatedSideEffects(sideEffects.snapshot())).toBe(
		true,
	)

	const fetchOnly = createEvaluationSideEffectTracker()
	fetchOnly.recordFetchAttempt()
	expect(fetchOnly.snapshot()).toEqual({
		dispatcherAttempts: 0,
		fetchAttempts: 1,
	})
	expect(evaluationHasHostMediatedSideEffects(fetchOnly.snapshot())).toBe(true)

	expect(isPlatformOnlyHostSideEffectProvider(hostSideEffectProviderName)).toBe(
		true,
	)
	expect(
		isPlatformOnlyHostSideEffectProvider(
			staticCallMeterRuntimeBridgeProviderName,
		),
	).toBe(true)
	expect(isPlatformOnlyHostSideEffectProvider('kody')).toBe(false)

	const provider = createHostSideEffectProvider(fetchOnly)
	expect(provider.name).toBe(hostSideEffectProviderName)
})
