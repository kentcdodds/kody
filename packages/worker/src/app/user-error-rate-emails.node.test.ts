import { expect, test, vi } from 'vitest'

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const {
	sendUserErrorRateEmails,
	shouldSendUserErrorRateEmail,
	userErrorRateEmailKvKey,
	userErrorRateMinErrors,
} = await import('#app/user-error-rate-emails.ts')

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(key: string, value: string) {
				store.set(key, value)
			},
		} as unknown as KVNamespace,
	}
}

function createEnv(input: {
	users: Array<{
		stable_user_id: string
		email: string
		event_count: number
		error_count: number
	}>
	kv?: KVNamespace
}) {
	return {
		APP_DB: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind() {
						return this
					},
					async all<T>() {
						if (normalized.includes('from usage_rollups')) {
							return { results: input.users as Array<T> }
						}
						return { results: [] }
					},
				}
			},
		} as unknown as D1Database,
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input.kv,
	} as unknown as Env
}

test('error-rate emails skip below-threshold users and claim once per month', async () => {
	expect(shouldSendUserErrorRateEmail({ errorCount: 4, eventCount: 10 })).toBe(
		false,
	)
	expect(shouldSendUserErrorRateEmail({ errorCount: 5, eventCount: 30 })).toBe(
		false,
	)
	expect(shouldSendUserErrorRateEmail({ errorCount: 5, eventCount: 25 })).toBe(
		true,
	)
	expect(
		shouldSendUserErrorRateEmail({ errorCount: 10, eventCount: 200 }),
	).toBe(true)

	const { kv, store } = createKv()
	const now = new Date('2026-08-15T12:00:00.000Z')
	const env = createEnv({
		users: [
			{
				stable_user_id: 'user-low',
				email: 'low@example.com',
				event_count: 30,
				error_count: userErrorRateMinErrors,
			},
			{
				stable_user_id: 'user-hot',
				email: 'hot@example.com',
				event_count: 20,
				error_count: 10,
			},
		],
		kv,
	})

	const first = await sendUserErrorRateEmails({ env, now })
	expect(first).toEqual({ status: 'notified', emailedUsers: 1 })
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		html: string
		text: string
	}
	expect(payload.to).toBe('hot@example.com')
	expect(payload.html).toContain('https://kody.codes/account/activity')
	expect(payload.text).toContain('/@kentcdodds/kody-issue-triage')
	expect(
		store.get(
			userErrorRateEmailKvKey({ userId: 'user-hot', month: '2026-08' }),
		),
	).toBeTruthy()

	sendCloudflareEmail.mockClear()
	const again = await sendUserErrorRateEmails({ env, now })
	expect(again).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})
