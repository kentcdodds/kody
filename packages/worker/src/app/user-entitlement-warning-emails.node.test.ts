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

const { sendUserEntitlementWarningEmails, userEntitlementWarningKvKey } =
	await import('#app/user-entitlement-warning-emails.ts')

const stableUserId = 'a'.repeat(64)

function consumptionRow(input: {
	resource: string
	label: string
	current: number
	limit: number
}) {
	return {
		...input,
		percentOfLimit: input.current / input.limit,
		overEightyPercent: input.current / input.limit > 0.8,
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

test('user entitlement warnings send one 80% email and one 100% email per UTC day regardless of resource', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { kv, store } = createKv()
	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 200,
			limit: 250,
		}),
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9,
			limit: 10,
		}),
		consumptionRow({
			resource: 'secrets',
			label: 'secrets',
			current: 4,
			limit: 25,
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
		emailsSent: 1,
		warnedResources: 2,
	})
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const approachingPayload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		from: string
		subject: string
		html: string
		text: string
	}
	expect(approachingPayload.to).toBe('jelias@example.com')
	expect(approachingPayload.from).toBe('kody@heykody.dev')
	expect(approachingPayload.subject).toContain('approaching')
	expect(approachingPayload.html).toContain(
		'https://heykody.dev/account/billing',
	)
	expect(approachingPayload.text).toContain('https://heykody.dev/account/usage')
	expect(approachingPayload.html).toContain('execute calls per day')
	expect(approachingPayload.html).toContain('saved packages')
	expect(approachingPayload.html).not.toContain('secrets')
	expect(approachingPayload.html).toContain(
		'https://heykody.dev/images/kody-lantern.png',
	)

	const approachingKey = userEntitlementWarningKvKey({
		userId: stableUserId,
		kind: 'approaching',
		day: utcDayKey(now),
	})
	expect(store.get(approachingKey)).toBe(String(now.getTime()))
	expect(
		store.get(
			userEntitlementWarningKvKey({
				userId: stableUserId,
				kind: 'reached',
				day: utcDayKey(now),
			}),
		),
	).toBeUndefined()

	sendCloudflareEmail.mockClear()
	const stillApproaching = await sendUserEntitlementWarningEmails({
		env,
		now: new Date(now.getTime() + 60 * 60 * 1000),
	})
	expect(stillApproaching).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 250,
			limit: 250,
		}),
		consumptionRow({
			resource: 'outbound_fetches_per_day',
			label: 'outbound fetches per day',
			current: 500,
			limit: 500,
		}),
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9,
			limit: 10,
		}),
	])
	const reached = await sendUserEntitlementWarningEmails({
		env,
		now: new Date(now.getTime() + 2 * 60 * 60 * 1000),
	})
	expect(reached).toEqual({
		status: 'notified',
		emailedUsers: 1,
		emailsSent: 1,
		warnedResources: 2,
	})
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const reachedPayload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		subject: string
		html: string
	}
	expect(reachedPayload.subject).toContain('reached')
	expect(reachedPayload.html).toContain('execute calls per day')
	expect(reachedPayload.html).toContain('outbound fetches per day')
	expect(reachedPayload.html).not.toContain('saved packages')
	expect(
		store.get(
			userEntitlementWarningKvKey({
				userId: stableUserId,
				kind: 'reached',
				day: utcDayKey(now),
			}),
		),
	).toBe(String(now.getTime() + 2 * 60 * 60 * 1000))

	sendCloudflareEmail.mockClear()
	const sameDay = await sendUserEntitlementWarningEmails({
		env,
		now: new Date(now.getTime() + 3 * 60 * 60 * 1000),
	})
	expect(sameDay).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const nextDay = new Date('2026-07-26T01:00:00.000Z')
	const nextDayResult = await sendUserEntitlementWarningEmails({
		env,
		now: nextDay,
	})
	expect(nextDayResult).toEqual({
		status: 'notified',
		emailedUsers: 1,
		emailsSent: 2,
		warnedResources: 3,
	})
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(2)
	const nextSubjects = sendCloudflareEmail.mock.calls.map(
		(call) => (call[1] as { subject: string }).subject,
	)
	expect(nextSubjects).toEqual([
		"You've reached a Kody plan limit",
		"You're approaching a Kody plan limit",
	])
})

test('user entitlement warnings skip when KV or transactional email is missing', async () => {
	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 200,
			limit: 250,
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
