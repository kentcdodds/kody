import { expect, test, vi } from 'vitest'
import {
	buildSystemEmailSentEvent,
	buildSystemEmailSentIdempotencyKey,
	systemEmailSentTopic,
} from './system-email-sent-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchSystemEmailSentSubscriptionEvent } =
	await import('./system-email-sent-package-subscriptions.ts')

test('system email sent dispatch fans the sent snapshot through admin package fan-out', async () => {
	const event = buildSystemEmailSentEvent({
		from: 'kody@kody.example.com',
		to: ['reporter@example.com'],
		subject: 'Thanks for the report',
		text: 'We shipped the fix.',
		providerMessageId: 'provider-1',
		sentAt: '2026-08-31T16:00:00.000Z',
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

	const result = await dispatchSystemEmailSentSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://kody.example.com',
		},
		event,
	})

	expect(result[0]).toMatchObject({
		params: event,
		idempotencyKey: buildSystemEmailSentIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: systemEmailSentTopic,
			source: 'system-email-sent',
			actorTokenId: 'internal:system-email-sent-subscriptions',
		},
	})
})
