import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const {
	authDenialAlertKvKey,
	checkAuthDenialBurstAndNotify,
	shouldRunAuthDenialAlertCron,
} = await import('#app/auth-denial-alerts.ts')

function createDb(count: number) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(..._params: Array<unknown>) {
					return this
				},
				async first<T>() {
					if (normalized.includes('from audit_events')) {
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

test('auth denial burst alerts stay quiet below threshold, then notify and cool down', async () => {
	expect(
		shouldRunAuthDenialAlertCron(new Date('2026-07-25T12:00:00.000Z')),
	).toBe(true)
	expect(
		shouldRunAuthDenialAlertCron(new Date('2026-07-25T12:05:00.000Z')),
	).toBe(false)

	sendCloudflareEmail.mockClear()
	const quiet = await checkAuthDenialBurstAndNotify({
		env: {
			APP_DB: createDb(10),
			AUDIT_DB: createDb(10),
			APP_BASE_URL: 'https://heykody.dev',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		threshold: 50,
	})
	expect(quiet).toEqual({ status: 'below_threshold', count: 10 })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

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
		APP_DB: createDb(80),
		AUDIT_DB: createDb(80),
		APP_BASE_URL: 'https://heykody.dev',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: kv,
	}
	const now = new Date('2026-07-25T12:00:00.000Z')
	try {
		const first = await checkAuthDenialBurstAndNotify({
			env,
			now,
			threshold: 50,
		})
		expect(first).toEqual({ status: 'notified', count: 80, recipients: 1 })
		expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
		expect(kvStore.get(authDenialAlertKvKey)).toBe(String(now.getTime()))
		expect(consoleWarn).toHaveBeenCalledWith(
			'auth-denial-burst-alerted',
			expect.objectContaining({ count: 80 }),
		)

		const second = await checkAuthDenialBurstAndNotify({
			env,
			now: new Date(now.getTime() + 60_000),
			threshold: 50,
		})
		expect(second).toEqual({ status: 'cooldown', count: 80 })
		expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	} finally {
		consoleWarn.mockReset()
	}
})
