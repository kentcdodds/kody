import { expect, test } from 'vitest'
import {
	buildSystemEmailSentEvent,
	buildSystemEmailSentIdempotencyKey,
	isSystemEmailSentEventTopic,
	systemEmailSentTopic,
} from './system-email-sent-subscription-event.ts'

test('system email sent event carries the operator correspondence snapshot', () => {
	const event = buildSystemEmailSentEvent({
		from: 'kody@kody.example.com',
		to: ['reporter@example.com'],
		subject: 'Thanks for the report',
		text: 'We shipped the fix.',
		html: '<p>We shipped the fix.</p>',
		replyTo: 'support@kody.example.com',
		providerMessageId: 'provider-1',
		sentAt: '2026-08-31T16:00:00.000Z',
	})

	expect(event).toEqual({
		event: systemEmailSentTopic,
		from: 'kody@kody.example.com',
		to: ['reporter@example.com'],
		subject: 'Thanks for the report',
		text: 'We shipped the fix.',
		html: '<p>We shipped the fix.</p>',
		reply_to: 'support@kody.example.com',
		provider_message_id: 'provider-1',
		sent_at: '2026-08-31T16:00:00.000Z',
	})
	expect(isSystemEmailSentEventTopic('email.system-message.received')).toBe(
		false,
	)
	expect(isSystemEmailSentEventTopic(systemEmailSentTopic)).toBe(true)
	expect(
		buildSystemEmailSentIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
	).toBe('system-email-sent:email.system-message.sent:provider-1:package-1')
	expect(
		buildSystemEmailSentIdempotencyKey({
			event: buildSystemEmailSentEvent({
				from: 'kody@kody.example.com',
				to: ['reporter@example.com'],
				subject: 'Hi',
				sentAt: '2026-08-31T16:00:00.000Z',
			}),
			packageId: 'package-1',
		}),
	).toBe(
		'system-email-sent:email.system-message.sent:2026-08-31T16:00:00.000Z:package-1',
	)
})
