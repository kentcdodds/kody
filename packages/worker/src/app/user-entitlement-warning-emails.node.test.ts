import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import type { EntitlementResource } from '#universal/plans.ts'

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
	userEntitlementWarningDailyKvKey,
	userEntitlementWarningKvKey,
} = await import('#app/user-entitlement-warning-emails.ts')

const stableUserId = 'a'.repeat(64)

function consumptionRow(input: {
	resource: EntitlementResource
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
			async delete(key: string) {
				store.delete(key)
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
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input.kv,
	} as unknown as Env
}

function instanceKey(
	kind: 'approaching' | 'reached',
	resource: EntitlementResource,
	now?: Date,
) {
	return userEntitlementWarningKvKey({
		userId: stableUserId,
		kind,
		resource,
		day: now ? utcDayKey(now) : undefined,
	})
}

test('user entitlement warnings mail once per entitlement crossing, not once per day', async () => {
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
	expect(approachingPayload.from).toBe('kody@kody.codes')
	expect(approachingPayload.subject).toContain('approaching')
	expect(approachingPayload.html).toContain(
		'https://kody.codes/account/billing',
	)
	expect(approachingPayload.text).toContain('https://kody.codes/account/usage')
	expect(approachingPayload.html).toContain('execute calls per day')
	expect(approachingPayload.html).toContain('saved packages')
	expect(approachingPayload.html).not.toContain('secrets')
	expect(
		store.get(instanceKey('approaching', 'execute_calls_per_day', now)),
	).toBe(String(now.getTime()))
	expect(store.get(instanceKey('approaching', 'saved_packages'))).toBe(
		String(now.getTime()),
	)
	expect(
		store.get(instanceKey('reached', 'execute_calls_per_day', now)),
	).toBeUndefined()

	sendCloudflareEmail.mockClear()
	const stillApproaching = await sendUserEntitlementWarningEmails({
		env,
		now: new Date(now.getTime() + 60 * 60 * 1000),
	})
	expect(stillApproaching).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	sendCloudflareEmail.mockClear()
	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 10,
			limit: 250,
		}),
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9,
			limit: 10,
		}),
	])
	const nextDayStillApproaching = await sendUserEntitlementWarningEmails({
		env,
		now: new Date('2026-07-26T01:00:00.000Z'),
	})
	expect(nextDayStillApproaching).toEqual({ status: 'no_warnings' })
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
	const reachedAt = new Date('2026-07-26T03:00:00.000Z')
	const reached = await sendUserEntitlementWarningEmails({
		env,
		now: reachedAt,
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
		store.get(instanceKey('reached', 'execute_calls_per_day', reachedAt)),
	).toBe(String(reachedAt.getTime()))
	expect(
		store.get(instanceKey('approaching', 'execute_calls_per_day', reachedAt)),
	).toBe(String(reachedAt.getTime()))
	expect(
		store.get(instanceKey('reached', 'outbound_fetches_per_day', reachedAt)),
	).toBe(String(reachedAt.getTime()))

	sendCloudflareEmail.mockClear()
	const stillReachedSameDay = await sendUserEntitlementWarningEmails({
		env,
		now: new Date('2026-07-26T04:00:00.000Z'),
	})
	expect(stillReachedSameDay).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 200,
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
	sendCloudflareEmail.mockClear()
	const nextUtcDay = new Date('2026-07-27T02:00:00.000Z')
	const droppedToApproaching = await sendUserEntitlementWarningEmails({
		env,
		now: nextUtcDay,
	})
	expect(droppedToApproaching).toEqual({
		status: 'notified',
		emailedUsers: 1,
		emailsSent: 2,
		warnedResources: 2,
	})
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(2)
	expect(
		store.get(instanceKey('reached', 'outbound_fetches_per_day', nextUtcDay)),
	).toBe(String(nextUtcDay.getTime()))
	expect(
		store.get(instanceKey('approaching', 'execute_calls_per_day', nextUtcDay)),
	).toBe(String(nextUtcDay.getTime()))
	expect(
		store.get(instanceKey('reached', 'execute_calls_per_day', nextUtcDay)),
	).toBeUndefined()

	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 10,
			limit: 250,
		}),
		consumptionRow({
			resource: 'outbound_fetches_per_day',
			label: 'outbound fetches per day',
			current: 0,
			limit: 500,
		}),
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 2,
			limit: 10,
		}),
	])
	const clearedAt = new Date('2026-07-27T04:00:00.000Z')
	await sendUserEntitlementWarningEmails({ env, now: clearedAt })
	expect(
		store.get(instanceKey('approaching', 'execute_calls_per_day', clearedAt)),
	).toBeUndefined()
	expect(
		store.get(instanceKey('approaching', 'saved_packages')),
	).toBeUndefined()
	expect(
		store.get(instanceKey('reached', 'outbound_fetches_per_day', clearedAt)),
	).toBeUndefined()

	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 10,
			limit: 10,
		}),
	])
	sendCloudflareEmail.mockClear()
	const jumpedToLimit = new Date('2026-07-27T05:00:00.000Z')
	const jumped = await sendUserEntitlementWarningEmails({
		env,
		now: jumpedToLimit,
	})
	expect(jumped).toEqual({
		status: 'notified',
		emailedUsers: 1,
		emailsSent: 1,
		warnedResources: 1,
	})
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	expect(
		(sendCloudflareEmail.mock.calls[0]?.[1] as { subject: string }).subject,
	).toContain('reached')
	expect(store.get(instanceKey('reached', 'saved_packages'))).toBe(
		String(jumpedToLimit.getTime()),
	)
	expect(store.get(instanceKey('approaching', 'saved_packages'))).toBe(
		String(jumpedToLimit.getTime()),
	)

	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 9,
			limit: 10,
		}),
	])
	sendCloudflareEmail.mockClear()
	const afterDropFromLimit = await sendUserEntitlementWarningEmails({
		env,
		now: new Date('2026-07-27T06:00:00.000Z'),
	})
	expect(afterDropFromLimit).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('user entitlement warnings absorb leftover daily claims without mailing again', async () => {
	const now = new Date('2026-08-24T03:00:00.000Z')
	const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
	const { kv, store } = createKv()
	store.set(
		userEntitlementWarningDailyKvKey({
			userId: stableUserId,
			kind: 'reached',
			day: utcDayKey(twoDaysAgo),
		}),
		String(twoDaysAgo.getTime()),
	)
	readAdminEntitlementConsumption.mockResolvedValue([
		consumptionRow({
			resource: 'saved_packages',
			label: 'saved packages',
			current: 10,
			limit: 10,
		}),
	])
	sendCloudflareEmail.mockClear()
	const env = createEnv({
		users: [
			{
				stable_user_id: stableUserId,
				email: 'maciek@example.com',
				plan: 'free',
				stripe_plan: null,
			},
		],
		kv,
	})

	const absorbed = await sendUserEntitlementWarningEmails({ env, now })
	expect(absorbed).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(store.get(instanceKey('reached', 'saved_packages'))).toBe(
		String(now.getTime()),
	)
	expect(store.get(instanceKey('approaching', 'saved_packages'))).toBe(
		String(now.getTime()),
	)

	sendCloudflareEmail.mockClear()
	const nextDay = await sendUserEntitlementWarningEmails({
		env,
		now: new Date('2026-08-25T01:00:00.000Z'),
	})
	expect(nextDay).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
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
