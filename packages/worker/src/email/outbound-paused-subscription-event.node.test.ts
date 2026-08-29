import { expect, test } from 'vitest'
import { buildUserEmailOutboundPausedEvent } from './outbound-paused-subscription-event.ts'

test('outbound-paused event clears bounce_threshold when the reason is complained', () => {
	expect(
		buildUserEmailOutboundPausedEvent({
			user: {
				id: 'user-1',
				username: 'ada',
				email: 'ada@example.com',
			},
			reason: 'complained',
			bounceThreshold: 5,
			adminUserUrl: 'https://kody.codes/admin/users/user-1',
			occurredAt: '2026-08-28T12:00:00.000Z',
		}).bounce_threshold,
	).toBeNull()
	expect(
		buildUserEmailOutboundPausedEvent({
			user: {
				id: 'user-1',
				username: 'ada',
				email: 'ada@example.com',
			},
			reason: 'bounced',
			bounceThreshold: 5,
			adminUserUrl: 'https://kody.codes/admin/users/user-1',
			occurredAt: '2026-08-28T12:00:00.000Z',
		}).bounce_threshold,
	).toBe(5)
})
