import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'

const readAdminEntitlementConsumption = vi.fn()

vi.mock('#worker/admin/entitlement-consumption.ts', () => ({
	readAdminEntitlementConsumption: (...args: Array<unknown>) =>
		readAdminEntitlementConsumption(...args),
	entitlementWarningThreshold: 0.8,
}))

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const {
	sendUserEntitlementWarningEmails,
	userEntitlementWarningKvKey,
	userEntitlementWarningPeriodKey,
} = await import('#app/user-entitlement-warning-emails.ts')

const stableUserId = 'a'.repeat(64)

function consumptionRow(input: {
	resource: string
	label: string
	current: number
	limit: number
	overEightyPercent: boolean
}) {
	return {
		...input,
		percentOfLimit: input.current / input.limit,
	}
}

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

function createDb(
	users: Array<{
		stable_user_id: string
		email: string
		plan: string
		stripe_plan: string | null
	}>,
) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(..._params: Array<unknown>) {
					return this
				},
				async all<T>() {
					if (normalized.includes('from usage_rollups')) {
						return { results: users as Array<T> }
					}
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
}

function createEnv(input: {
	users: Array<{
		stable_user_id: string
		email: string
		plan: string
		stripe_plan: string | null
	}>
	kv?: KVNamespace
}) {
	return {
		APP_DB: createDb(input.users),
		APP_BASE_URL: 'https://heykody.dev/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input.kv,
	} as unknown as Env
}

test('user entitlement warnings email once per daily resource then cool down until the next UTC day', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { kv, store } = createKv()
	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 200,
			limit: 250,
			overEightyPercent: true,
		}),
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9,
			limit: 10,
			overEightyPercent: true,
		}),
		consumptionRow({
			resource: 'secrets',
			label: 'secrets',
			current: 4,
			limit: 25,
			overEightyPercent: false,
		}),
	])
	const env = createEnv({
		users: [
			{
				stable_user_id: stableUserId,
				email: 'jelias@example.com',
				plan: 'free',
				stripe_plan: null,
			},
		],
		kv,
	})

	const first = await sendUserEntitlementWarningEmails({ env, now })
	expect(first).toEqual({
		status: 'notified',
		emailedUsers: 1,
		warnedResources: 2,
	})
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		from: string
		subject: string
		html: string
		text: string
	}
	expect(payload.to).toBe('jelias@example.com')
	expect(payload.from).toBe('kody@heykody.dev')
	expect(payload.subject).toContain('plan limit')
	expect(payload.html).toContain('https://heykody.dev/account/billing')
	expect(payload.text).toContain('https://heykody.dev/account/usage')
	expect(payload.html).toContain('execute calls per day')
	expect(payload.html).toContain('saved packages')
	expect(payload.html).not.toContain('secrets')
	expect(payload.html).toContain('https://heykody.dev/images/kody-lantern.png')
	expect(payload.html).toContain('https://heykody.dev/images/kody-mark.png')

	const executeKey = userEntitlementWarningKvKey({
		userId: stableUserId,
		resource: 'execute_calls_per_day',
		period: userEntitlementWarningPeriodKey('execute_calls_per_day', now),
	})
	const packagesKey = userEntitlementWarningKvKey({
		userId: stableUserId,
		resource: 'saved_packages',
		period: userEntitlementWarningPeriodKey('saved_packages', now),
	})
	expect(store.get(executeKey)).toBe(String(now.getTime()))
	expect(store.get(packagesKey)).toBe(String(now.getTime()))
	expect(userEntitlementWarningPeriodKey('execute_calls_per_day', now)).toBe(
		utcDayKey(now),
	)
	expect(userEntitlementWarningPeriodKey('saved_packages', now)).toBe('stock')

	sendCloudflareEmail.mockClear()
	const second = await sendUserEntitlementWarningEmails({
		env,
		now: new Date(now.getTime() + 60 * 60 * 1000),
	})
	expect(second).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const nextDay = new Date('2026-07-26T01:00:00.000Z')
	const third = await sendUserEntitlementWarningEmails({
		env,
		now: nextDay,
	})
	expect(third).toEqual({
		status: 'notified',
		emailedUsers: 1,
		warnedResources: 1,
	})
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const nextPayload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		html: string
	}
	expect(nextPayload.html).toContain('execute calls per day')
	expect(nextPayload.html).not.toContain('saved packages')
})

test('user entitlement warnings skip when KV or transactional email is missing', async () => {
	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 200,
			limit: 250,
			overEightyPercent: true,
		}),
	])
	sendCloudflareEmail.mockClear()
	const noKv = await sendUserEntitlementWarningEmails({
		env: createEnv({
			users: [
				{
					stable_user_id: stableUserId,
					email: 'user@example.com',
					plan: 'free',
					stripe_plan: null,
				},
			],
		}),
	})
	expect(noKv).toEqual({ status: 'skipped', reason: 'no_kv' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const { kv } = createKv()
	const noConfig = await sendUserEntitlementWarningEmails({
		env: {
			APP_DB: createDb([]),
			BUNDLE_ARTIFACTS_KV: kv,
		} as unknown as Env,
	})
	expect(noConfig).toEqual({ status: 'skipped', reason: 'no_email_config' })
})
