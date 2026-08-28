import { expect, test, vi } from 'vitest'
import {
	buildUserEmailOutboundPausedEvent,
	buildUserEmailOutboundPausedIdempotencyKey,
	userEmailOutboundPausedTopic,
} from './outbound-paused-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchUserEmailOutboundPausedSubscriptionEvent } =
	await import('./outbound-paused-package-subscriptions.ts')

test('outbound-paused dispatch fans the operator snapshot through admin package fan-out', async () => {
	const event = buildUserEmailOutboundPausedEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		reason: 'complained',
		adminUserUrl: 'https://heykody.dev/admin/users/user-1',
		occurredAt: '2026-08-28T12:00:00.000Z',
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

	const result = await dispatchUserEmailOutboundPausedSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		},
		event,
	})

	expect(result[0]).toMatchObject({
		params: event,
		idempotencyKey: buildUserEmailOutboundPausedIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: userEmailOutboundPausedTopic,
			source: 'user-email-outbound-paused',
			actorTokenId: 'internal:user-email-outbound-paused-subscriptions',
		},
	})
})
