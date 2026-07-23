import { expect, test } from 'vitest'
import { resolveSubscriptionEffectFailure } from './inbound-effects.ts'

test('subscription effects retry transient failures twice then dead-letter', () => {
	expect(resolveSubscriptionEffectFailure(0)).toEqual({
		attemptCount: 1,
		deadLettered: false,
	})
	expect(resolveSubscriptionEffectFailure(1)).toEqual({
		attemptCount: 2,
		deadLettered: false,
	})
	expect(resolveSubscriptionEffectFailure(2)).toEqual({
		attemptCount: 3,
		deadLettered: true,
	})
})
