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
					if (normalized.includes('from email_delivery_alert_events')) {
						return { count } as T
					}
					return null
				},
				async all<T>() {
					if (normalized.includes('from users as user')) {
						return {
							results: [{ email: 'admin@example.com' }],
						} as { results: Array<T> }
					}
					return { results: [] }
				},
				async run() {
					return { meta: { changes: 0 } }
				},
			}
		},
	} as unknown as D1Database
}

test('thin delivery alert signals notify once per cooldown window', async () => {
	expect(
		shouldRunEmailDeliveryAlertCron(new Date('2026-07-25T12:00:00.000Z')),
	).toBe(true)
	expect(
		shouldRunEmailDeliveryAlertCron(new Date('2026-07-25T12:05:00.000Z')),
	).toBe(false)
	sendCloudflareEmail.mockClear()
	const quiet = await checkEmailDeliveryBurstAndNotify({
		env: { APP_DB: createDb(10), APP_BASE_URL: 'https://heykody.dev' },
		threshold: 20,
	})
	expect(quiet).toEqual({ status: 'below_threshold', count: 10 })

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
		APP_BASE_URL: 'https://heykody.dev/',
		USER_EMAIL_DOMAIN: 'mail.heykody.dev',
		BUNDLE_ARTIFACTS_KV: kv,
	}
	const now = new Date('2026-07-25T12:00:00.000Z')
	try {
		await expect(
			checkEmailDeliveryBurstAndNotify({ env, now, threshold: 20 }),
		).resolves.toEqual({ status: 'notified', count: 35, recipients: 1 })
		const payload = sendCloudflareEmail.mock.calls[0]?.[1] as { text: string }
		expect(payload.text).toContain('https://heykody.dev/admin/insights')
		expect(payload.text).not.toContain('heykody.dev//')
		expect(kvStore.get(emailDeliveryAlertKvKey)).toBe(String(now.getTime()))
		await expect(
			checkEmailDeliveryBurstAndNotify({
				env,
				now: new Date(now.getTime() + 60_000),
				threshold: 20,
			}),
		).resolves.toEqual({ status: 'cooldown', count: 35 })
		expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	} finally {
		consoleWarn.mockReset()
	}
})
