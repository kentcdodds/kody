import { expect, test } from 'vitest'
import {
	firstCapabilityDispatchWarnMs,
	shouldWarnFirstCapabilityDispatch,
} from './first-capability-dispatch.ts'

test('first capability dispatch warn stays off under Vitest and fires only when the probe is enabled past the budget', () => {
	expect(shouldWarnFirstCapabilityDispatch(firstCapabilityDispatchWarnMs)).toBe(
		false,
	)
	expect(shouldWarnFirstCapabilityDispatch(10_000)).toBe(false)
	expect(
		shouldWarnFirstCapabilityDispatch(firstCapabilityDispatchWarnMs - 1, {
			probeEnabled: true,
		}),
	).toBe(false)
	expect(
		shouldWarnFirstCapabilityDispatch(firstCapabilityDispatchWarnMs, {
			probeEnabled: true,
		}),
	).toBe(true)
})
