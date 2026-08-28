import { expect, test } from 'vitest'
import {
	buildEmailDeliveryBurstEvent,
	buildEmailDeliveryBurstIdempotencyKey,
	emailDeliveryBurstTopic,
	isEmailDeliveryBurstEventTopic,
} from './email-delivery-burst-subscription-event.ts'

test('email-delivery burst event builders keep a metadata-only operator snapshot', () => {
	const event = buildEmailDeliveryBurstEvent({
		count: 35,
		threshold: 20,
		windowMinutes: 60,
		insightsUrl: 'https://kody.codes/admin/insights',
		observedAt: '2026-08-28T12:00:00.000Z',
	})

	expect(event).toEqual({
		event: emailDeliveryBurstTopic,
		count: 35,
		threshold: 20,
		window_minutes: 60,
		insights_url: 'https://kody.codes/admin/insights',
		observed_at: '2026-08-28T12:00:00.000Z',
	})
	expect(isEmailDeliveryBurstEventTopic('auth.denial.burst')).toBe(false)
	expect(isEmailDeliveryBurstEventTopic(emailDeliveryBurstTopic)).toBe(true)
	expect(
		buildEmailDeliveryBurstIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
	).toBe(
		'email-delivery:email.delivery.burst:2026-08-28T12:00:00.000Z:package-1',
	)
})
