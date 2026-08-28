import { expect, test, vi } from 'vitest'
import {
	buildUserEmailVerificationFailedEvent,
	buildUserEmailVerificationFailedIdempotencyKey,
	userEmailVerificationFailedTopic,
} from './email-verification-failed-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchUserEmailVerificationFailedSubscriptionEvent } =
	await import('./email-verification-failed-package-subscriptions.ts')

test('verification-failed dispatch fans the operator snapshot through admin package fan-out', async () => {
	const event = buildUserEmailVerificationFailedEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		status: 'bounced',
		class: 'sender_block',
		adminUserUrl: 'https://heykody.dev/admin/users/user-1',
		occurredAt: '2026-08-28T02:00:00.000Z',
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

	const result = await dispatchUserEmailVerificationFailedSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		},
		event,
	})

	expect(result[0]).toMatchObject({
		params: event,
		idempotencyKey: buildUserEmailVerificationFailedIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: userEmailVerificationFailedTopic,
			source: 'user-email-verification-failed',
			actorTokenId: 'internal:user-email-verification-failed-subscriptions',
		},
	})
})
