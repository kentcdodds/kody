import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const {
	emailDeliveryAlertKvKey,
	checkEmailDeliveryBurstAndNotify,
	shouldRunEmailDeliveryAlertCron,
} = await import('#app/email-delivery-alerts.ts')

function createDb(count: number) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(..._params: Array<unknown>) {
					return this
				},
				async first<T>() {
					if (normalized.includes('from email_delivery_events')) {
						return { count } as T
					}
					return null
				},
				async all<T>() {
					if (normalized.includes('from users u')) {
						return {
							results: [{ email: 'admin@example.com' }],
						} as { results: Array<T> }
					}
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
}

test('shouldRunEmailDeliveryAlertCron runs on the hour', () => {
	expect(
		shouldRunEmailDeliveryAlertCron(new Date('2026-07-25T12:00:00.000Z')),
	).toBe(true)
	expect(
		shouldRunEmailDeliveryAlertCron(new Date('2026-07-25T12:05:00.000Z')),
	).toBe(false)
})

test('checkEmailDeliveryBurstAndNotify stays quiet below threshold', async () => {
	sendCloudflareEmail.mockClear()
	const result = await checkEmailDeliveryBurstAndNotify({
		env: {
			APP_DB: createDb(10),
			APP_BASE_URL: 'https://heykody.dev',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		threshold: 20,
	})
	expect(result).toEqual({ status: 'below_threshold', count: 10 })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('checkEmailDeliveryBurstAndNotify emails admins and respects cooldown', async () => {
	sendCloudflareEmail.mockClear()
	consoleWarn.mockImplementation(() => {})
	const kvStore = new Map<string, string>()
	const kv = {
		async get(key: string) {
			return kvStore.get(key) ?? null
		},
		async put(key: string, value: string) {
			kvStore.set(key, value)
		},
	} as unknown as KVNamespace

	const env = {
		APP_DB: createDb(35),
		APP_BASE_URL: 'https://heykody.dev',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: kv,
	}
	const now = new Date('2026-07-25T12:00:00.000Z')
	try {
		const first = await checkEmailDeliveryBurstAndNotify({
			env,
			now,
			threshold: 20,
		})
		expect(first).toEqual({ status: 'notified', count: 35, recipients: 1 })
		expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
		expect(kvStore.get(emailDeliveryAlertKvKey)).toBe(String(now.getTime()))
		expect(consoleWarn).toHaveBeenCalledWith(
			'email-delivery-burst-alerted',
			expect.objectContaining({ count: 35 }),
		)

		const second = await checkEmailDeliveryBurstAndNotify({
			env,
			now: new Date(now.getTime() + 60_000),
			threshold: 20,
		})
		expect(second).toEqual({ status: 'cooldown', count: 35 })
		expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	} finally {
		consoleWarn.mockReset()
	}
})

test('checkEmailDeliveryBurstAndNotify does not write cooldown when notify fails', async () => {
	sendCloudflareEmail.mockClear()
	sendCloudflareEmail.mockRejectedValueOnce(new Error('cf email down'))
	consoleWarn.mockImplementation(() => {})
	const kvStore = new Map<string, string>()
	const kv = {
		async get(key: string) {
			return kvStore.get(key) ?? null
		},
		async put(key: string, value: string) {
			kvStore.set(key, value)
		},
	} as unknown as KVNamespace

	const env = {
		APP_DB: createDb(35),
		APP_BASE_URL: 'https://heykody.dev',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: kv,
	}
	try {
		await expect(
			checkEmailDeliveryBurstAndNotify({
				env,
				now: new Date('2026-07-25T12:00:00.000Z'),
				threshold: 20,
			}),
		).rejects.toThrow('cf email down')
		expect(kvStore.has(emailDeliveryAlertKvKey)).toBe(false)
		expect(consoleWarn).toHaveBeenCalledWith(
			'email-delivery-alert-notification-failed',
			expect.any(Error),
		)
	} finally {
		consoleWarn.mockReset()
		sendCloudflareEmail.mockResolvedValue({ ok: true })
	}
})
