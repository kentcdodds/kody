import { expect, test } from 'vitest'
import {
	buildUserEmailVerificationFailedEvent,
	buildUserEmailVerificationFailedIdempotencyKey,
	isUserEmailVerificationFailedEventTopic,
	isUserEmailVerificationFailedStatus,
	userEmailVerificationFailedTopic,
} from './email-verification-failed-subscription-event.ts'

test('verification-failed event builders keep a metadata-only operator snapshot', () => {
	const event = buildUserEmailVerificationFailedEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		status: 'bounced',
		class: 'sender_block',
		adminUserUrl: 'https://kody.codes/admin/users/user-1',
		occurredAt: '2026-08-28T02:00:00.000Z',
	})

	expect(event).toEqual({
		event: userEmailVerificationFailedTopic,
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		status: 'bounced',
		class: 'sender_block',
		admin_user_url: 'https://kody.codes/admin/users/user-1',
		occurred_at: '2026-08-28T02:00:00.000Z',
	})
	expect(
		buildUserEmailVerificationFailedEvent({
			user: event.user,
			status: 'failed',
			class: 'not-a-class',
			adminUserUrl: event.admin_user_url,
			occurredAt: event.occurred_at,
		}).class,
	).toBeNull()
	expect(isUserEmailVerificationFailedEventTopic('user.created')).toBe(false)
	expect(isUserEmailVerificationFailedStatus('delivered')).toBe(false)
	expect(isUserEmailVerificationFailedStatus('bounced')).toBe(true)
	expect(
		buildUserEmailVerificationFailedIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
	).toBe(
		'user-email-verification:user.email_verification.failed:user-1:2026-08-28T02:00:00.000Z:package-1',
	)
})
