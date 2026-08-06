import { expect, test } from 'vitest'
import { adminGrantDiffersFromSubscription } from '#app/account-plan-display.ts'

test('adminGrantDiffersFromSubscription hides the usual subscriber and free cases', () => {
	expect(adminGrantDiffersFromSubscription('free', null)).toBe(false)
	expect(adminGrantDiffersFromSubscription('free', 'pro')).toBe(false)
	expect(adminGrantDiffersFromSubscription('pro', 'pro')).toBe(false)
	expect(adminGrantDiffersFromSubscription('standard', 'standard')).toBe(false)

	expect(adminGrantDiffersFromSubscription('max', null)).toBe(true)
	expect(adminGrantDiffersFromSubscription('max', 'pro')).toBe(true)
	expect(adminGrantDiffersFromSubscription('pro', null)).toBe(true)
	expect(adminGrantDiffersFromSubscription('pro', 'standard')).toBe(true)
})
