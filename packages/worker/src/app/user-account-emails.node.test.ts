import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

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
	userAccountEmailKvKey,
} = await import('#app/user-account-emails.ts')

/** 30-day KV claim TTL — public contract for once-per-kind sends. */
const accountEmailClaimTtlSeconds = 30 * 24 * 60 * 60

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
			async delete(key: string) {
				store.delete(key)
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
	expect(payload.html).toContain('https://kody.codes/onboarding')
	expect(payload.text).toContain('https://kody.codes/onboarding')
	expect(
		store.get(
			userAccountEmailKvKey({ userId: 'user-1', kind: 'connect_agent' }),
		),
	).toBeTruthy()
	expect(puts[0]?.options?.expirationTtl).toBe(accountEmailClaimTtlSeconds)

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

test('account emails reserve the KV claim before sending and release it on send failure', async () => {
	const { kv, store } = createKv()
	const env = createEnv(kv)
	const order: Array<string> = []
	const originalPut = kv.put.bind(kv)
	kv.put = async (...args: Parameters<KVNamespace['put']>) => {
		order.push('put')
		return originalPut(...args)
	}
	sendCloudflareEmail.mockImplementation(async () => {
		order.push('send')
		return { ok: true }
	})

	expect(
		await sendConnectAgentEmail({
			env,
			email: 'ada@example.com',
			userId: 'user-claim',
		}),
	).toBe(true)
	expect(order).toEqual(['put', 'send'])

	sendCloudflareEmail.mockImplementation(async () => {
		throw new Error('smtp down')
	})
	consoleWarn.mockImplementation(() => {})
	expect(
		await sendBillingSuccessEmail({
			env,
			email: 'ada@example.com',
			userId: 'user-claim',
			planLabel: 'Pro',
		}),
	).toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith('user-account-email-send-failed', {
		kind: 'billing_success',
		error: expect.any(Error),
	})
	expect(
		store.get(
			userAccountEmailKvKey({
				userId: 'user-claim',
				kind: 'billing_success',
				suffix: 'pro',
			}),
		),
	).toBeUndefined()
})
