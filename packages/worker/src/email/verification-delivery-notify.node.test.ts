import { expect, test, vi } from 'vitest'
import { userEmailVerificationFailedTopic } from '#worker/identity/email-verification-failed-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchUserEmailVerificationFailedSubscriptionEvent: vi.fn(async () => []),
}))

vi.mock(
	'#worker/identity/email-verification-failed-package-subscriptions.ts',
	() => ({
		dispatchUserEmailVerificationFailedSubscriptionEvent:
			mocks.dispatchUserEmailVerificationFailedSubscriptionEvent,
	}),
)

const { notifyAdminsOfVerificationDeliveryFailure } =
	await import('./verification-delivery-notify.ts')

test('verification delivery notify fans the admin event via waitUntil without blocking', async () => {
	mocks.dispatchUserEmailVerificationFailedSubscriptionEvent.mockImplementationOnce(
		() => new Promise(() => {}),
	)
	const first = vi.fn().mockResolvedValue({
		username: 'ada',
		email: 'ada@example.com',
		stable_user_id: 'user-1',
	})
	const prepare = vi.fn(() => ({ bind: () => ({ first }) }))
	const env = {
		APP_DB: { prepare },
		APP_BASE_URL: 'https://kody.codes',
		BUNDLE_ARTIFACTS_KV: {},
	} as unknown as Env
	const waitUntil = vi.fn()

	await notifyAdminsOfVerificationDeliveryFailure({
		env,
		event: {
			userId: 9,
			kind: 'email_verification',
			recipient: 'ada@example.com',
			status: 'bounced',
			class: 'sender_block',
			alreadyTerminal: false,
		},
		waitUntil,
	})

	expect(
		mocks.dispatchUserEmailVerificationFailedSubscriptionEvent,
	).toHaveBeenCalledWith({
		env,
		event: expect.objectContaining({
			event: userEmailVerificationFailedTopic,
			user: {
				id: 'user-1',
				username: 'ada',
				email: 'ada@example.com',
			},
			status: 'bounced',
			class: 'sender_block',
			admin_user_url: 'https://kody.codes/admin/users/user-1',
		}),
		waitUntil,
	})
	expect(prepare).toHaveBeenCalledOnce()
	expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
})
