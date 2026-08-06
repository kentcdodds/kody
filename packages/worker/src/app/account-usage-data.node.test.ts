import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { accountUsageEntitlementResources } from '#worker/entitlements/resource-visibility.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { loadAccountUsageData } from '#app/account-usage-data.ts'

function withUsageEnv(
	env: { APP_DB: D1Database } & Record<string, unknown>,
	mailboxMessageCount = 0,
) {
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	const countMessages = async () => ({ total: mailboxMessageCount })
	return {
		...env,
		...meter.env,
		...runLog.env,
		MAILBOX: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ countMessages }),
		},
		meter,
		runLog,
	}
}

function createUsageTestDb(input: {
	userId: number
	email: string
	plan: string
	stripePlan?: string | null
	packageCount?: number
}) {
	const stableUserId = testStableUserIdFromEmail(input.email)
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
								if (normalized.includes('select 1 as present from users')) {
									return { present: 1 } as T
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
	expect(baseline?.manualPlan).toBe('free')
	expect(baseline?.stripePlan).toBe(null)
	expect(baseline?.today).toBe('2026-07-25')
	expect(currentFor(baseline, 'saved_packages')?.current).toBe(2)
	expect(currentFor(baseline, 'concurrent_workflows')?.current).toBe(0)
	expect(baseline?.entitlementConsumption.length).toBe(
		accountUsageEntitlementResources.length,
	)

	const bootstrapEmail = 'usage-bootstrap@example.com'
	const bootstrapUserId = testStableUserIdFromEmail(bootstrapEmail)
	const { db: bootstrapDb } = createUsageTestDb({
		userId: 8,
		email: bootstrapEmail,
		plan: 'pro',
		packageCount: 1,
	})
	const bootstrapEnv = withUsageEnv({ APP_DB: bootstrapDb })
	await bootstrapEnv.meter.seed({
		userId: bootstrapUserId,
		resource: 'email_sends_per_day',
		day,
		count: 17,
	})
	await bootstrapEnv.meter.seed({
		userId: bootstrapUserId,
		resource: 'execute_calls_per_day',
		day,
		count: 91,
	})
	const bootstrapped = await loadAccountUsageData({
		env: bootstrapEnv as Env,
		userId: 8,
		now,
	})
	expect(currentFor(bootstrapped, 'email_sends_per_day')?.current).toBe(17)
	expect(currentFor(bootstrapped, 'execute_calls_per_day')?.current).toBe(91)
	expect(currentFor(bootstrapped, 'saved_packages')?.current).toBe(1)

	const meterEmail = 'usage-meter@example.com'
	const meterUserId = testStableUserIdFromEmail(meterEmail)
	const { db: warmDb } = createUsageTestDb({
		userId: 9,
		email: meterEmail,
		plan: 'pro',
		packageCount: 4,
	})
	const warmEnv = withUsageEnv({ APP_DB: warmDb }, 7)
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
	expect(currentFor(authoritative, 'email_sends_per_day')?.current).toBe(101)
	expect(currentFor(authoritative, 'email_receives_per_day')?.current).toBe(202)
	expect(currentFor(authoritative, 'execute_calls_per_day')?.current).toBe(303)
	expect(currentFor(authoritative, 'outbound_fetches_per_day')?.current).toBe(
		404,
	)
	expect(currentFor(authoritative, 'concurrent_workflows')?.current).toBe(3)
	expect(currentFor(authoritative, 'stored_email_messages')?.current).toBe(7)
	expect(currentFor(authoritative, 'saved_packages')?.current).toBe(4)

	const storageEmail = 'usage-storage@example.com'
	const storageUserId = testStableUserIdFromEmail(storageEmail)
	const { db: storageDb } = createUsageTestDb({
		userId: 11,
		email: storageEmail,
		plan: 'pro',
		packageCount: 0,
	})
	const storageEnv = withUsageEnv({ APP_DB: storageDb })
	await storageEnv.meter.seedStorageBytes({
		userId: storageUserId,
		bytes: 4_321,
	})
	const storageData = await loadAccountUsageData({
		env: storageEnv as Env,
		userId: 11,
		now,
	})
	expect(currentFor(storageData, 'storage_bytes')?.current).toBe(4_321)

	const { db: grantDb } = createUsageTestDb({
		userId: 12,
		email: 'usage-grant@example.com',
		plan: 'max',
		stripePlan: null,
	})
	const grantData = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: grantDb }) as Env,
		userId: 12,
		now,
	})
	expect(grantData?.plan).toBe('max')
	expect(grantData?.manualPlan).toBe('max')
	expect(grantData?.stripePlan).toBe(null)

	const { db: subscribedDb } = createUsageTestDb({
		userId: 13,
		email: 'usage-sub@example.com',
		plan: 'free',
		stripePlan: 'pro',
	})
	const subscribedData = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: subscribedDb }) as Env,
		userId: 13,
		now,
	})
	expect(subscribedData?.plan).toBe('pro')
	expect(subscribedData?.manualPlan).toBe('free')
	expect(subscribedData?.stripePlan).toBe('pro')
})
