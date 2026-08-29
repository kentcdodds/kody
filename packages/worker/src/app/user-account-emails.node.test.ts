import { expect, test, vi } from 'vitest'

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const {
	sendBillingSuccessEmail,
	sendConnectAgentEmail,
	sendPastDueEmail,
	sendPaymentFailedEmail,
	userAccountEmailClaimTtlSeconds,
	userAccountEmailKvKey,
} = await import('#app/user-account-emails.ts')

function createKv() {
	const store = new Map<string, string>()
	const puts: Array<{
		key: string
		value: string
		options?: { expirationTtl?: number }
	}> = []
	return {
		store,
		puts,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(
				key: string,
				value: string,
				options?: { expirationTtl?: number },
			) {
				puts.push({ key, value, options })
				store.set(key, value)
			},
		} as unknown as KVNamespace,
	}
}

function createEnv(kv?: KVNamespace) {
	return {
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env
}

test('account emails claim once per kind and skip when KV or sender is missing', async () => {
	expect(
		await sendConnectAgentEmail({
			env: createEnv(),
			email: 'ada@example.com',
			userId: 'user-1',
		}),
	).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const { kv, store, puts } = createKv()
	const env = createEnv(kv)
	expect(
		await sendConnectAgentEmail({
			env,
			email: 'ada@example.com',
			userId: 'user-1',
		}),
	).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		subject: string
		html: string
		text: string
	}
	expect(payload.to).toBe('ada@example.com')
	expect(payload.subject).toContain('Connect your agent')
	expect(payload.html).toContain('https://kody.codes/onboarding')
	expect(payload.text).toContain('https://kody.codes/onboarding')
	expect(
		store.get(
			userAccountEmailKvKey({ userId: 'user-1', kind: 'connect_agent' }),
		),
	).toBeTruthy()
	expect(puts[0]?.options?.expirationTtl).toBe(userAccountEmailClaimTtlSeconds)

	sendCloudflareEmail.mockClear()
	expect(
		await sendConnectAgentEmail({
			env,
			email: 'ada@example.com',
			userId: 'user-1',
		}),
	).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	expect(
		await sendBillingSuccessEmail({
			env,
			email: 'ada@example.com',
			userId: 'user-1',
			planLabel: 'Pro',
		}),
	).toBe(true)
	expect(
		await sendPaymentFailedEmail({
			env,
			email: 'ada@example.com',
			userId: 'user-1',
			day: '2026-08-29',
		}),
	).toBe(true)
	expect(
		await sendPastDueEmail({
			env,
			email: 'ada@example.com',
			userId: 'user-1',
			day: '2026-08-29',
		}),
	).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(3)
})
