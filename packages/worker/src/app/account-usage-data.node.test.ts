import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
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
	const repoSessionIndex = createInMemoryRepoSessionIndexEnv(env.APP_DB)
	const countMessages = async () => ({ total: mailboxMessageCount })
	return {
		...env,
		...meter.env,
		...runLog.env,
		REPO_SESSION_INDEX: repoSessionIndex.REPO_SESSION_INDEX,
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
	entitlementLadder?: string | null
	stripeCustomerId?: string | null
	packageCount?: number
	uniqueWorkerDays?: number
	durableObjectRowsRead?: number
	creditsEligible?: boolean
	creditBalanceMicroUsd?: number
	giftExpiresAt?: string
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
										entitlement_ladder: input.entitlementLadder ?? 'public',
										stripe_credits_eligible: input.creditsEligible ? 1 : 0,
										second_agent_standard_gift_expires_at:
											input.giftExpiresAt ?? null,
										stable_user_id: stableUserId,
										stripe_customer_id: input.stripeCustomerId ?? null,
									} as T
								}
								if (normalized.includes('from credit_wallets')) {
									return {
										balance_micro_usd: input.creditBalanceMicroUsd ?? 0,
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
								if (normalized.includes('from usage_rollups')) {
									const results = []
									if ((input.uniqueWorkerDays ?? 0) > 0) {
										results.push({
											metric: 'dynamic_worker_day',
											event_count: input.uniqueWorkerDays,
										})
									}
									if ((input.durableObjectRowsRead ?? 0) > 0) {
										results.push({
											metric: 'durable_object_rows_read',
											event_count: input.durableObjectRowsRead,
										})
									}
									return { results }
								}
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
	expect(currentFor(authoritative, 'execute_calls_per_day')?.week).toEqual({
		current: 303,
		limit: 4_000,
		percentOfLimit: 303 / 4_000,
		overEightyPercent: false,
	})
	expect(currentFor(authoritative, 'outbound_fetches_per_day')?.current).toBe(
		404,
	)
	expect(authoritative?.weekStart).toBe('2026-07-20')
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
	expect(baseline?.computeOverage.creditsStatus).toBe('within_include')
	expect(baseline?.computeOverage.creditWallet).toBe('none')
	expect(baseline?.computeOverage.meters).toHaveLength(2)
})

test('Free over compute includes is sent to /account/credits to switch to Pro, not charged', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { db } = createUsageTestDb({
		userId: 21,
		email: 'usage-free-over@example.com',
		plan: 'free',
		uniqueWorkerDays: 60,
	})
	const data = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: db }) as Env,
		userId: 21,
		now,
	})
	expect(data?.computeOverage.creditsStatus).toBe('switch_to_pro')
	const uniqueWorkerDays = data?.computeOverage.meters.find(
		(meter) => meter.resource === 'unique_worker_days',
	)
	expect(uniqueWorkerDays?.overEightyPercent).toBe(true)
	expect(uniqueWorkerDays?.howToReduce).toMatch(
		/Switch to Pro at \/account\/credits/,
	)
	expect(uniqueWorkerDays?.howToReduce).not.toMatch(/payment method|invoice/)
	expect(
		data?.warnings.some((row) => row.resource === 'unique_worker_days'),
	).toBe(true)
})

test('retired Standard over compute includes is not charged and has no wallet', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { db } = createUsageTestDb({
		userId: 22,
		email: 'usage-legacy@example.com',
		plan: 'standard',
		stripePlan: 'standard',
		entitlementLadder: 'legacy',
		stripeCustomerId: 'cus_legacy',
		uniqueWorkerDays: 400,
		creditBalanceMicroUsd: 5_000_000,
	})
	const data = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: db }) as Env,
		userId: 22,
		now,
	})
	expect(data?.computeOverage.creditWallet).toBe('none')
	expect(data?.computeOverage.creditsStatus).toBe('switch_to_pro')
	const uniqueWorkerDays = data?.computeOverage.meters.find(
		(meter) => meter.resource === 'unique_worker_days',
	)
	expect(uniqueWorkerDays?.howToReduce).toMatch(/not charged on your plan/)
	expect(uniqueWorkerDays?.howToReduce).not.toMatch(/payment method/)
})

test('purchasable Pro with credits shows unlocked limits and debits above the include', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { db } = createUsageTestDb({
		userId: 24,
		email: 'usage-credits@example.com',
		plan: 'free',
		stripePlan: 'pro',
		creditsEligible: true,
		creditBalanceMicroUsd: 10_000_000,
		stripeCustomerId: 'cus_credits',
		uniqueWorkerDays: 400,
	})
	const funded = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: db }) as Env,
		userId: 24,
		now,
	})
	expect(funded?.computeOverage.creditWallet).toBe('funded')
	expect(funded?.computeOverage.creditsStatus).toBe('debiting_credits')
	expect(funded?.computeOverage.creditsCostMicroUsd).toBe(50 * 4_000)
	expect(currentFor(funded, 'execute_calls_per_day')?.limit).toBe(25_000)
	expect(currentFor(funded, 'email_sends_per_day')?.limit).toBe(200)

	const { db: emptyDb } = createUsageTestDb({
		userId: 25,
		email: 'usage-credits-empty@example.com',
		plan: 'free',
		stripePlan: 'pro',
		creditsEligible: true,
		creditBalanceMicroUsd: 0,
		stripeCustomerId: 'cus_credits_empty',
		uniqueWorkerDays: 400,
	})
	const empty = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: emptyDb }) as Env,
		userId: 25,
		now,
	})
	expect(funded?.canBuyCredits).toBe(true)
	expect(empty?.computeOverage.creditWallet).toBe('empty')
	expect(empty?.computeOverage.creditsStatus).toBe('add_credits')
	expect(empty?.canBuyCredits).toBe(true)
	expect(currentFor(empty, 'execute_calls_per_day')?.limit).toBe(500)
	expect(currentFor(empty, 'execute_calls_per_day')?.howToReduce).toMatch(
		/credits at \/account\/credits raise this limit/,
	)
})

test('gift Pro keeps retired Pro ceilings without a wallet and cannot buy credits', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const { db } = createUsageTestDb({
		userId: 26,
		email: 'usage-gift@example.com',
		plan: 'free',
		giftExpiresAt: '2026-08-25T00:00:00.000Z',
		uniqueWorkerDays: 400,
	})
	const data = await loadAccountUsageData({
		env: withUsageEnv({ APP_DB: db }) as Env,
		userId: 26,
		now,
	})
	expect(data?.plan).toBe('pro')
	expect(data?.computeOverage.creditWallet).toBe('none')
	expect(data?.computeOverage.creditsStatus).toBe('within_include')
	expect(data?.canBuyCredits).toBe(false)
	const uniqueWorkerDays = data?.computeOverage.meters.find(
		(meter) => meter.resource === 'unique_worker_days',
	)
	expect(uniqueWorkerDays?.include).toBe(2_000)
	expect(currentFor(data, 'execute_calls_per_day')?.limit).toBe(1_500)
	for (const row of [
		...(data?.entitlementConsumption ?? []),
		...(data?.computeOverage.meters ?? []),
	]) {
		expect(row.howToReduce).not.toMatch(/^add credits/i)
		expect(row.howToReduce).not.toMatch(/add credits to lift/i)
	}
})
