import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { loadAccountUsageData } from '#app/account-usage-data.ts'

function withUsageEnv(env: { APP_DB: D1Database } & Record<string, unknown>) {
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	return { ...env, ...meter.env, ...runLog.env, meter, runLog }
}

type DailyCounterRow = {
	user_id: string
	resource: string
	day: string
	count: number
}

function createUsageTestDb(input: {
	userId: number
	email: string
	plan: string
	stripePlan?: string | null
	packageCount?: number
	dailyCounters?: Array<DailyCounterRow>
	d1StorageBytes?: number
}) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	const dailyCounters = input.dailyCounters?.map((row) => ({ ...row })) ?? []
	const d1StorageBytes = input.d1StorageBytes ?? 0
	return {
		stableUserId,
		db: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind(...params: Array<unknown>) {
						return {
							async first<T>() {
								if (
									normalized.includes('from users') &&
									normalized.includes('where id')
								) {
									return {
										id: input.userId,
										plan: input.plan,
										stripe_plan: input.stripePlan ?? null,
										stable_user_id: stableUserId,
									} as T
								}
								if (normalized.includes('from saved_packages')) {
									return { count: input.packageCount ?? 0 } as T
								}
								if (normalized.includes('from entitlement_daily_counters')) {
									const row = dailyCounters.find(
										(counter) =>
											counter.user_id === params[0] &&
											counter.resource === params[1] &&
											counter.day === params[2],
									)
									return (row ? { count: row.count } : { count: 0 }) as T
								}
								if (normalized.includes('d1_storage_bytes')) {
									return { bytes: d1StorageBytes } as T
								}
								if (
									normalized.includes('count(*)') ||
									normalized.includes('sum(')
								) {
									return { count: 0, total: 0, bytes: 0 } as T
								}
								void params
								return null
							},
							async all() {
								return { results: [] }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
	}
}

function currentFor(
	data: Awaited<ReturnType<typeof loadAccountUsageData>>,
	resource: string,
) {
	return data?.entitlementConsumption.find((row) => row.resource === resource)
		?.current
}

test('loadAccountUsageData returns plan rows and authoritative UserMeter daily counts', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const day = utcDayKey(now)

	const { db: emptyDailyDb } = createUsageTestDb({
		userId: 7,
		email: 'usage@example.com',
		plan: 'free',
		packageCount: 2,
	})
	const baselineEnv = withUsageEnv({ APP_DB: emptyDailyDb })
	const baseline = await loadAccountUsageData({
		env: baselineEnv as Env,
		userId: 7,
		now,
	})
	expect(baseline?.ok).toBe(true)
	expect(baseline?.plan).toBe('free')
	expect(baseline?.today).toBe('2026-07-25')
	expect(currentFor(baseline, 'saved_packages')).toBe(2)
	expect(currentFor(baseline, 'concurrent_workflows')).toBe(0)
	expect(baseline?.entitlementConsumption.length).toBeGreaterThan(5)

	const bootstrapEmail = 'usage-bootstrap@example.com'
	const bootstrapUserId = testStableUserIdFromEmail(bootstrapEmail)
	const { db: bootstrapDb } = createUsageTestDb({
		userId: 8,
		email: bootstrapEmail,
		plan: 'pro',
		packageCount: 1,
		dailyCounters: [
			{
				user_id: bootstrapUserId,
				resource: 'email_sends_per_day',
				day,
				count: 17,
			},
			{
				user_id: bootstrapUserId,
				resource: 'execute_calls_per_day',
				day,
				count: 91,
			},
		],
	})
	const bootstrapped = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: bootstrapDb }) as Env,
		userId: 8,
		now,
	})
	expect(currentFor(bootstrapped, 'email_sends_per_day')).toBe(17)
	expect(currentFor(bootstrapped, 'execute_calls_per_day')).toBe(91)
	expect(currentFor(bootstrapped, 'saved_packages')).toBe(1)

	const meterEmail = 'usage-meter@example.com'
	const meterUserId = testStableUserIdFromEmail(meterEmail)
	const { db: warmDb } = createUsageTestDb({
		userId: 9,
		email: meterEmail,
		plan: 'pro',
		packageCount: 4,
		dailyCounters: [
			{
				user_id: meterUserId,
				resource: 'email_sends_per_day',
				day,
				count: 11,
			},
			{
				user_id: meterUserId,
				resource: 'email_receives_per_day',
				day,
				count: 22,
			},
			{
				user_id: meterUserId,
				resource: 'execute_calls_per_day',
				day,
				count: 33,
			},
			{
				user_id: meterUserId,
				resource: 'outbound_fetches_per_day',
				day,
				count: 44,
			},
		],
	})
	const warmEnv = withUsageEnv({ APP_DB: warmDb })
	warmEnv.runLog.setActiveWorkflowCount(meterUserId, 3)
	warmEnv.runLog.setActiveWorkflowCount('other-user', 99)
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'email_sends_per_day',
		day,
		count: 101,
	})
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'email_receives_per_day',
		day,
		count: 202,
	})
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'execute_calls_per_day',
		day,
		count: 303,
	})
	await warmEnv.meter.seed({
		userId: meterUserId,
		resource: 'outbound_fetches_per_day',
		day,
		count: 404,
	})
	const authoritative = await loadAccountUsageData({
		env: warmEnv as Env,
		userId: 9,
		now,
	})
	expect(currentFor(authoritative, 'email_sends_per_day')).toBe(101)
	expect(currentFor(authoritative, 'email_receives_per_day')).toBe(202)
	expect(currentFor(authoritative, 'execute_calls_per_day')).toBe(303)
	expect(currentFor(authoritative, 'outbound_fetches_per_day')).toBe(404)
	expect(currentFor(authoritative, 'concurrent_workflows')).toBe(3)
	expect(currentFor(authoritative, 'saved_packages')).toBe(4)
})

test('loadAccountUsageData prefers D1 storage_bytes over a divergent UserMeter shadow', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const email = 'usage-storage@example.com'
	const userId = testStableUserIdFromEmail(email)
	const { db } = createUsageTestDb({
		userId: 11,
		email,
		plan: 'pro',
		packageCount: 0,
		d1StorageBytes: 4_321,
	})
	const usageEnv = withUsageEnv({ APP_DB: db })
	await usageEnv.meter.seedStorageBytes({ userId, bytes: 321 })
	const data = await loadAccountUsageData({
		env: usageEnv as Env,
		userId: 11,
		now,
	})
	expect(currentFor(data, 'storage_bytes')).toBe(4_321)
})
