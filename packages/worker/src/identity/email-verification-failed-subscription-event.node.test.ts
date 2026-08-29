import { expect, test } from 'vitest'
import { buildUserEmailVerificationFailedEvent } from './email-verification-failed-subscription-event.ts'

test('verification-failed event nulls unrecognized delivery classes', () => {
	expect(
		buildUserEmailVerificationFailedEvent({
			user: {
				id: 'user-1',
				username: 'ada',
				email: 'ada@example.com',
			},
			status: 'failed',
			class: 'not-a-class',
			adminUserUrl: 'https://kody.codes/admin/users/user-1',
			occurredAt: '2026-08-28T02:00:00.000Z',
		}).class,
	).toBeNull()
	expect(
		buildUserEmailVerificationFailedEvent({
			user: {
				id: 'user-1',
				username: 'ada',
				email: 'ada@example.com',
			},
			status: 'bounced',
			class: 'sender_block',
			adminUserUrl: 'https://kody.codes/admin/users/user-1',
			occurredAt: '2026-08-28T02:00:00.000Z',
		}).class,
	).toBe('sender_block')
})
