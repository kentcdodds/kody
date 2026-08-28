import { expect, test } from 'vitest'
import {
	authDenialBurstTopic,
	buildAuthDenialBurstEvent,
	buildAuthDenialBurstIdempotencyKey,
	isAuthDenialBurstEventTopic,
} from './auth-denial-subscription-event.ts'

test('auth-denial burst event builders keep a metadata-only operator snapshot', () => {
	const event = buildAuthDenialBurstEvent({
		count: 80,
		threshold: 50,
		windowMinutes: 60,
		insightsUrl: 'https://kody.codes/admin/insights',
		observedAt: '2026-08-28T12:00:00.000Z',
	})

	expect(event).toEqual({
		event: authDenialBurstTopic,
		count: 80,
		threshold: 50,
		window_minutes: 60,
		insights_url: 'https://kody.codes/admin/insights',
		observed_at: '2026-08-28T12:00:00.000Z',
	})
	expect(isAuthDenialBurstEventTopic('email.delivery.burst')).toBe(false)
	expect(isAuthDenialBurstEventTopic(authDenialBurstTopic)).toBe(true)
	expect(
		buildAuthDenialBurstIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
	).toBe('auth-denial:auth.denial.burst:2026-08-28T12:00:00.000Z:package-1')
})
