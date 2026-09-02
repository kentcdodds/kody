import { expect, test } from 'vitest'
import {
	acceptedEmailVerificationDelivery,
	isAdminUserVerificationFilter,
	isStalledEmailVerificationDelivery,
} from './email-verification-delivery.ts'

test('stalled verification is derived from accepted age, not a stored status', () => {
	const now = new Date('2026-09-01T10:00:00.000Z')
	expect(
		isStalledEmailVerificationDelivery(
			{
				emailVerified: false,
				delivery: acceptedEmailVerificationDelivery('2026-09-01T08:45:16.921Z'),
			},
			now,
		),
	).toBe(true)
	expect(
		isStalledEmailVerificationDelivery(
			{
				emailVerified: false,
				delivery: acceptedEmailVerificationDelivery('2026-09-01T09:30:00.000Z'),
			},
			now,
		),
	).toBe(false)
	expect(
		isStalledEmailVerificationDelivery(
			{
				emailVerified: true,
				delivery: acceptedEmailVerificationDelivery('2026-09-01T08:00:00.000Z'),
			},
			now,
		),
	).toBe(false)
	expect(isAdminUserVerificationFilter('accepted')).toBe(false)
})
