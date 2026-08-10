import { expect, test } from 'vitest'
import {
	buildSubscriptionInvocationRunMetadata,
	stripUntrustedSubscriptionEnvelopeFields,
} from './subscription-envelope.ts'

test('subscription envelope strips forged markers and builds run metadata from trusted source', () => {
	expect(
		stripUntrustedSubscriptionEnvelopeFields({
			event: 'email.message.received',
			synthetic: true,
			replay_of: 'message-1',
			message: { id: 'message-1' },
		}),
	).toEqual({
		event: 'email.message.received',
		message: { id: 'message-1' },
	})
	expect(
		stripUntrustedSubscriptionEnvelopeFields({
			payload: { synthetic: true },
		}),
	).toEqual({
		payload: { synthetic: true },
	})

	expect(
		buildSubscriptionInvocationRunMetadata({
			exportName: 'subscription:email.message.received',
			isSubscription: true,
			source: 'synthetic',
			topic: 'email.message.received',
			params: {
				event: 'email.message.received',
				synthetic: true,
				replay_of: 'message-1',
			},
		}),
	).toEqual({
		exportName: 'subscription:email.message.received',
		source: 'synthetic',
		topic: 'email.message.received',
		synthetic: true,
		replay_of: 'message-1',
	})
	expect(
		buildSubscriptionInvocationRunMetadata({
			exportName: 'subscription:email.message.received',
			isSubscription: true,
			source: 'email',
			topic: 'email.message.received',
			params: {
				event: 'email.message.received',
				synthetic: true,
				replay_of: 'message-1',
			},
		}),
	).toEqual({
		exportName: 'subscription:email.message.received',
		source: 'email',
		topic: 'email.message.received',
	})
	expect(
		buildSubscriptionInvocationRunMetadata({
			exportName: '.',
			isSubscription: false,
			source: 'synthetic',
			topic: null,
			params: { synthetic: true },
		}),
	).toEqual({
		exportName: '.',
		source: 'synthetic',
		topic: null,
	})
})
