import { expect, test } from 'vitest'
import {
	buildUserEmailOutboundPausedEvent,
	buildUserEmailOutboundPausedIdempotencyKey,
	isUserEmailOutboundPausedEventTopic,
	isUserEmailOutboundPausedReason,
	userEmailOutboundPausedTopic,
} from './outbound-paused-subscription-event.ts'

test('outbound-paused event builders keep a metadata-only operator snapshot', () => {
	const event = buildUserEmailOutboundPausedEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		reason: 'bounced',
		bounceThreshold: 5,
		adminUserUrl: 'https://kody.codes/admin/users/user-1',
		occurredAt: '2026-08-28T12:00:00.000Z',
	})

	expect(event).toEqual({
		event: userEmailOutboundPausedTopic,
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		reason: 'bounced',
		bounce_threshold: 5,
		admin_user_url: 'https://kody.codes/admin/users/user-1',
		occurred_at: '2026-08-28T12:00:00.000Z',
	})
	expect(
		buildUserEmailOutboundPausedEvent({
			user: event.user,
			reason: 'complained',
			bounceThreshold: 5,
			adminUserUrl: event.admin_user_url,
			occurredAt: event.occurred_at,
		}).bounce_threshold,
	).toBeNull()
	expect(isUserEmailOutboundPausedEventTopic('user.created')).toBe(false)
	expect(isUserEmailOutboundPausedReason('failed')).toBe(false)
	expect(isUserEmailOutboundPausedReason('complained')).toBe(true)
	expect(
		buildUserEmailOutboundPausedIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
	).toBe(
		'user-email-outbound:user.email_outbound.paused:user-1:2026-08-28T12:00:00.000Z:package-1',
	)
})
