import { expect, test, vi } from 'vitest'
import { userEmailVerificationFailedTopic } from '#worker/identity/email-verification-failed-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	sendCloudflareEmail: vi.fn(async () => ({ ok: true })),
	dispatchUserEmailVerificationFailedSubscriptionEvent: vi.fn(async () => []),
	getSystemEmailDomain: vi.fn(() => 'kody.codes'),
}))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		mocks.sendCloudflareEmail(...args),
}))

vi.mock(
	'#worker/identity/email-verification-failed-package-subscriptions.ts',
	() => ({
		dispatchUserEmailVerificationFailedSubscriptionEvent:
			mocks.dispatchUserEmailVerificationFailedSubscriptionEvent,
	}),
)

vi.mock('./platform-address.ts', () => ({
	getSystemEmailDomain: (...args: Array<unknown>) =>
		mocks.getSystemEmailDomain(...args),
}))

const { notifyAdminsOfVerificationDeliveryFailure } =
	await import('./verification-delivery-notify.ts')

test('verification delivery notify fans the admin event and emails every admin', async () => {
	const first = vi.fn().mockResolvedValue({
		username: 'ada',
		email: 'ada@example.com',
		stable_user_id: 'user-1',
	})
	const all = vi.fn().mockResolvedValue({
		results: [{ email: 'me@kentcdodds.com', username: 'kent' }],
	})
	const prepare = vi.fn((sql: string) => {
		if (sql.includes('stable_user_id')) {
			return { bind: () => ({ first }) }
		}
		return { all }
	})
	const env = {
		APP_DB: { prepare },
		APP_BASE_URL: 'https://kody.codes',
		BUNDLE_ARTIFACTS_KV: {},
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
		CLOUDFLARE_API_TOKEN: 'token',
	} as unknown as Env

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
		waitUntil: undefined,
	})
	expect(mocks.sendCloudflareEmail).toHaveBeenCalledWith(
		expect.objectContaining({ accountId: 'account' }),
		expect.objectContaining({
			to: 'me@kentcdodds.com',
			from: 'kody@kody.codes',
			subject: 'Verification email bounced for ada',
		}),
	)
})
