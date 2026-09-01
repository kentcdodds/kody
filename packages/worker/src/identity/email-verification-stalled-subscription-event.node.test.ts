import { expect, test } from 'vitest'
import {
	buildUserEmailVerificationStalledEvent,
	buildUserEmailVerificationStalledIdempotencyKey,
	userEmailVerificationStalledTopic,
} from './email-verification-stalled-subscription-event.ts'

test('stalled verification event keys one accepted send per subscriber', () => {
	const event = buildUserEmailVerificationStalledEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		acceptedAt: '2026-09-01T08:45:16.921Z',
		stallAfterMinutes: 60,
		adminUserUrl: 'https://kody.codes/admin/users/user-1',
		occurredAt: '2026-09-01T10:00:00.000Z',
	})
	expect(event).toEqual({
		event: userEmailVerificationStalledTopic,
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		status: 'accepted',
		accepted_at: '2026-09-01T08:45:16.921Z',
		stall_after_minutes: 60,
		admin_user_url: 'https://kody.codes/admin/users/user-1',
		occurred_at: '2026-09-01T10:00:00.000Z',
	})
	expect(
		buildUserEmailVerificationStalledIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
	).toBe(
		'user-email-verification:user.email_verification.stalled:user-1:2026-09-01T08:45:16.921Z:package-1',
	)
})
