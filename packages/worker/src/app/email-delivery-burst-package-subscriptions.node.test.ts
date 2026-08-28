import { expect, test, vi } from 'vitest'
import {
	buildEmailDeliveryBurstEvent,
	buildEmailDeliveryBurstIdempotencyKey,
	emailDeliveryBurstTopic,
} from './email-delivery-burst-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchEmailDeliveryBurstSubscriptionEvent } =
	await import('./email-delivery-burst-package-subscriptions.ts')

test('email-delivery burst dispatch fans the operator snapshot through admin package fan-out', async () => {
	const event = buildEmailDeliveryBurstEvent({
		count: 35,
		threshold: 20,
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

	const result = await dispatchEmailDeliveryBurstSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		},
		event,
	})

	expect(result[0]).toMatchObject({
		params: event,
		idempotencyKey: buildEmailDeliveryBurstIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: emailDeliveryBurstTopic,
			source: 'email-delivery-burst',
			actorTokenId: 'internal:email-delivery-burst-subscriptions',
		},
	})
})
