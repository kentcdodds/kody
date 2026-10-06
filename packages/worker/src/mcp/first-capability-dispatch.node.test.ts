import { expect, test } from 'vitest'
import {
	firstCapabilityDispatchWarnMs,
	shouldWarnFirstCapabilityDispatch,
} from './first-capability-dispatch.ts'

test('first capability dispatch warn fires at or above the budget', () => {
	expect(
		shouldWarnFirstCapabilityDispatch(firstCapabilityDispatchWarnMs - 1),
	).toBe(false)
	expect(shouldWarnFirstCapabilityDispatch(firstCapabilityDispatchWarnMs)).toBe(
		true,
	)
	expect(shouldWarnFirstCapabilityDispatch(10_000)).toBe(true)
})
