import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const detectFleetUsagePressure = vi.fn<
	(input: { db: D1Database; env: Env; now: Date }) => Promise<
		Array<
			| {
					kind: 'entitlement'
					stableUserId: string
					username: string
					resource: string
					label: string
					percentOfLimit: number
			  }
			| {
					kind: 'runtime_duration'
					stableUserId: string
					username: string
					totalDurationMs: number
			  }
		>
	>
>()

vi.mock('#worker/admin/fleet-usage-insights.ts', () => ({
	detectFleetUsagePressure: (input: { db: D1Database; env: Env; now: Date }) =>
		detectFleetUsagePressure(input),
	adminFleetEntitlementSweepUserLimit: 15,
	fleetRuntimeDurationAlertThresholdMs: 24 * 60 * 60 * 1000,
}))

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const {
	usageEntitlementAlertKvKey,
	checkUsageEntitlementPressureAndNotify,
	shouldRunUsageEntitlementAlertCron,
} = await import('#app/usage-entitlement-alerts.ts')

function createDb() {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(..._params: Array<unknown>) {
					return this
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

test('usage entitlement alerts stay quiet without pressure, then notify and cool down', async () => {
	expect(
		shouldRunUsageEntitlementAlertCron(new Date('2026-07-25T12:00:00.000Z')),
	).toBe(true)
	expect(
		shouldRunUsageEntitlementAlertCron(new Date('2026-07-25T12:05:00.000Z')),
	).toBe(false)

	detectFleetUsagePressure.mockResolvedValueOnce([])
	const quiet = await checkUsageEntitlementPressureAndNotify({
		env: { APP_DB: createDb() },
	})
	expect(quiet).toEqual({ status: 'no_pressure' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	detectFleetUsagePressure.mockResolvedValue([
		{
			kind: 'entitlement',
			stableUserId: 'user-a',
			username: 'alice',
			resource: 'secrets',
			label: 'secrets',
			percentOfLimit: 0.91,
		},
	])
	consoleWarn.mockImplementation(() => {})
	sendCloudflareEmail.mockClear()
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
		APP_DB: createDb(),
		APP_BASE_URL: 'https://heykody.dev/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: kv,
	}
	const now = new Date('2026-07-25T12:00:00.000Z')
	try {
		const first = await checkUsageEntitlementPressureAndNotify({ env, now })
		expect(first).toEqual({ status: 'notified', issueCount: 1, recipients: 1 })
		expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
		const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
			text: string
		}
		expect(payload.text).toContain('https://heykody.dev/admin/insights')
		expect(payload.text).toContain('https://heykody.dev/admin/users')
		expect(payload.text).not.toContain('https://heykody.dev//')
		expect(kvStore.get(usageEntitlementAlertKvKey)).toBe(String(now.getTime()))

		const second = await checkUsageEntitlementPressureAndNotify({
			env,
			now: new Date(now.getTime() + 60_000),
		})
		expect(second).toEqual({ status: 'cooldown', issueCount: 1 })
		expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	} finally {
		consoleWarn.mockReset()
	}
})

test('usage entitlement alerts no-op when no admins exist', async () => {
	detectFleetUsagePressure.mockResolvedValue([
		{
			kind: 'runtime_duration',
			stableUserId: 'user-b',
			username: 'bob',
			totalDurationMs: 99_999_999,
		},
	])
	const db = {
		prepare() {
			return {
				bind() {
					return this
				},
				async all() {
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
	const result = await checkUsageEntitlementPressureAndNotify({
		env: {
			APP_DB: db,
			APP_BASE_URL: 'https://heykody.dev/',
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token',
		},
	})
	expect(result).toEqual({ status: 'skipped', reason: 'no_admins' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})
