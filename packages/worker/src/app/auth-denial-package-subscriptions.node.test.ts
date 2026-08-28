import { expect, test, vi } from 'vitest'
import {
	authDenialBurstTopic,
	buildAuthDenialBurstEvent,
	buildAuthDenialBurstIdempotencyKey,
} from './auth-denial-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchAuthDenialBurstSubscriptionEvent } =
	await import('./auth-denial-package-subscriptions.ts')

test('auth-denial burst dispatch fans the operator snapshot through admin package fan-out', async () => {
	const event = buildAuthDenialBurstEvent({
		count: 80,
		threshold: 50,
		windowMinutes: 60,
		insightsUrl: 'https://heykody.dev/admin/insights',
		observedAt: '2026-08-28T12:00:00.000Z',
	})
	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: {
			getParams: () =>
				| Record<string, unknown>
				| Promise<Record<string, unknown>>
			buildIdempotencyKey: (savedPackage: { id: string }) => string
			[key: string]: unknown
		}) => [
			{
				params: await input.getParams(),
				idempotencyKey: input.buildIdempotencyKey({ id: 'package-1' }),
				input,
			},
		],
	)

	const result = await dispatchAuthDenialBurstSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		},
		event,
	})

	expect(result[0]).toMatchObject({
		params: event,
		idempotencyKey: buildAuthDenialBurstIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: authDenialBurstTopic,
			source: 'auth-denial-burst',
			actorTokenId: 'internal:auth-denial-burst-subscriptions',
		},
	})
})
