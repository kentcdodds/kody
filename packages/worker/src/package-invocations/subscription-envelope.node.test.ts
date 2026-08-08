import { expect, test } from 'vitest'
import { isMissingPackageModuleError } from './module-artifacts.ts'
import {
	buildFreshSyntheticSubscriptionIdempotencyKey,
	buildPackageSubscriptionNotFoundMessage,
	buildSubscriptionInvocationRunMetadata,
	packageSubscriptionDispatchCapabilityName,
	stripUntrustedSubscriptionEnvelopeFields,
} from './subscription-envelope.ts'

test('stripUntrustedSubscriptionEnvelopeFields removes top-level synthetic and replay_of', () => {
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
})

test('stripUntrustedSubscriptionEnvelopeFields leaves nested synthetic markers alone', () => {
	expect(
		stripUntrustedSubscriptionEnvelopeFields({
			payload: { synthetic: true },
		}),
	).toEqual({
		payload: { synthetic: true },
	})
})

test('buildPackageSubscriptionNotFoundMessage names package_subscription_dispatch', () => {
	expect(
		buildPackageSubscriptionNotFoundMessage({
			kodyId: 'demo',
			topic: 'email.message.received',
		}),
	).toContain(packageSubscriptionDispatchCapabilityName)
	expect(
		isMissingPackageModuleError(
			new Error('Package "demo" does not declare subscription "repo.pushed".'),
		),
	).toBe(true)
})

test('buildFreshSyntheticSubscriptionIdempotencyKey uses synthetic prefix and unique values', () => {
	const first = buildFreshSyntheticSubscriptionIdempotencyKey()
	const second = buildFreshSyntheticSubscriptionIdempotencyKey()

	expect(first).toMatch(/^synthetic:[0-9a-f-]{36}$/)
	expect(second).toMatch(/^synthetic:[0-9a-f-]{36}$/)
	expect(first).not.toBe(second)
})

test('buildSubscriptionInvocationRunMetadata carries synthetic markers from payload', () => {
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
})

test('buildSubscriptionInvocationRunMetadata omits synthetic markers for real dispatch', () => {
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
})

test('buildSubscriptionInvocationRunMetadata does not trust synthetic export sources', () => {
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
