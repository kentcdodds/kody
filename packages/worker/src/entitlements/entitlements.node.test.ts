import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	EntitlementLimitError,
	buildEntitlementLimitMessage,
	isEntitlementLimitError,
} from './errors.ts'
import {
	nullPlanEmailFallbackLimits,
	parsePlanName,
	planLimits,
	resolvePlanLimit,
} from './plans.ts'
import {
	assertWithinEntitlement,
	consumeDailyEntitlement,
	getUserPlan,
	incrementDailyEntitlementCounter,
} from './service.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'

type CounterRow = {
	user_id: string
	resource: string
	day: string
	count: number
}

function createEntitlementsTestDb(
	input: {
		users?: Array<{ email: string; plan: string | null }>
		counts?: Partial<
			Record<
				| 'saved_packages'
				| 'jobs'
				| 'repo_sessions'
				| 'package_runtime_runs'
				| 'secret_entries'
				| 'workflow_runs',
				number
			>
		>
		counters?: Array<CounterRow>
	} = {},
) {
	const users = input.users ?? []
	const counts = input.counts ?? {}
	const counters = input.counters ?? []
	const queries: Array<string> = []

	function countFor(query: string) {
		const tableNames = [
			'saved_packages',
			'jobs',
			'repo_sessions',
			'package_runtime_runs',
			'secret_entries',
			'workflow_runs',
		] as const
		for (const table of tableNames) {
			if (query.includes(`FROM ${table}`)) {
				return counts[table] ?? 0
			}
		}
		return null
	}

	const db = {
		prepare(query: string) {
			queries.push(query)
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (query.includes('SELECT plan FROM users')) {
								const user = users.find((row) => row.email === params[0])
								return (user ? { plan: user.plan } : null) as T | null
							}
							if (query.includes('FROM entitlement_daily_counters')) {
								const row = counters.find(
									(counter) =>
										counter.user_id === params[0] &&
										counter.resource === params[1] &&
										counter.day === params[2],
								)
								return (row ? { count: row.count } : null) as T | null
							}
							const count = countFor(query)
							if (count !== null) {
								return { count } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							if (query.includes('INSERT INTO entitlement_daily_counters')) {
								const isConditionalConsume = query.includes('count + 1 <= ?')
								const amount = isConditionalConsume ? 1 : Number(params[3])
								const existing = counters.find(
									(counter) =>
										counter.user_id === params[0] &&
										counter.resource === params[1] &&
										counter.day === params[2],
								)
								if (existing) {
									if (
										isConditionalConsume &&
										existing.count + 1 > Number(params[4])
									) {
										return { meta: { changes: 0 } }
									}
									existing.count += amount
								} else {
									counters.push({
										user_id: String(params[0]),
										resource: String(params[1]),
										day: String(params[2]),
										count: amount,
									})
								}
								return { meta: { changes: 1 } }
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, counters, queries }
}

const plannedEmail = 'planned@example.com'

test('getUserPlan resolves plans through hashed email and short-circuits invalid lookups', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db, queries } = createEntitlementsTestDb({
		users: [
			{ email: plannedEmail, plan: 'pro' },
			{ email: 'unknown-plan@example.com', plan: 'enterprise-2099' },
		],
	})
	expect(await getUserPlan(db, { userId: 'user-1', email: null })).toBeNull()
	expect(await getUserPlan(db, { userId: 'user-1', email: '' })).toBeNull()
	expect(
		await getUserPlan(db, { userId: 'user-1', email: plannedEmail }),
	).toBeNull()
	expect(queries).toEqual([])

	expect(await getUserPlan(db, { userId, email: plannedEmail })).toBe('pro')
	expect(
		await getUserPlan(db, { userId, email: ' Planned@Example.com ' }),
	).toBe('pro')

	const unknownPlanUserId = await createStableUserIdFromEmail(
		'unknown-plan@example.com',
	)
	expect(
		await getUserPlan(db, {
			userId: unknownPlanUserId,
			email: 'unknown-plan@example.com',
		}),
	).toBeNull()
	expect(parsePlanName('enterprise-2099')).toBeNull()
	expect(parsePlanName('personal')).toBe('personal')
})

test('assertWithinEntitlement is a no-op for users without a plan', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db, queries } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: null }],
		counts: { jobs: 10_000 },
	})
	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})
	// Only the plan lookup ran; no counting query for unlimited users.
	expect(queries).toHaveLength(1)
	expect(queries[0]).toContain('SELECT plan FROM users')
})

test('assertWithinEntitlement passes under the limit and throws at it', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const limit = planLimits.personal.maxScheduledJobs
	if (limit === null) throw new Error('Expected a numeric personal job limit.')
	const under = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'personal' }],
		counts: { jobs: limit - 1 },
	})
	await assertWithinEntitlement({
		db: under.db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})

	const at = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'personal' }],
		counts: { jobs: limit },
	})
	const error = await assertWithinEntitlement({
		db: at.db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(isEntitlementLimitError(error)).toBe(true)
	expect(error.details).toEqual({
		code: 'entitlement_limit_exceeded',
		resource: 'scheduled_jobs',
		plan: 'personal',
		limit,
		current: limit,
		upgradeHint: error.details.upgradeHint,
	})
	expect(error.message).toBe(buildEntitlementLimitMessage(error.details))
})

test('assertWithinEntitlement applies fallbackLimit for plan-less users', async () => {
	const { db } = createEntitlementsTestDb({
		counts: { workflow_runs: 100 },
	})
	const error = await assertWithinEntitlement({
		db,
		userId: 'user-1',
		email: null,
		resource: 'concurrent_workflows',
		fallbackLimit: 100,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(error.details).toMatchObject({
		plan: null,
		limit: 100,
		current: 100,
	})
})

test('persistent package services are gated as a zero limit', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	expect(resolvePlanLimit('personal', 'persistent_package_services')).toBe(0)
	expect(resolvePlanLimit('pro', 'persistent_package_services')).toBeNull()

	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'personal' }],
	})
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'persistent_package_services',
		}),
	).rejects.toThrow('at most 0 persistent package services')

	const proDb = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro' }],
	})
	await assertWithinEntitlement({
		db: proDb.db,
		userId,
		email: plannedEmail,
		resource: 'persistent_package_services',
	})
})

test('plan user daily entitlements increment, enforce at limit, and reset on a new UTC day', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const now = new Date('2026-07-05T15:00:00.000Z')
	const { db, counters } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'personal' }],
	})
	expect(utcDayKey(now)).toBe('2026-07-05')

	const limit = planLimits.personal.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric email send limit.')
	for (let index = 0; index < limit; index += 1) {
		await assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_sends_per_day',
			now,
		})
		await incrementDailyEntitlementCounter({
			db,
			userId,
			resource: 'email_sends_per_day',
			now,
		})
	}
	expect(counters).toEqual([
		{
			user_id: userId,
			resource: 'email_sends_per_day',
			day: '2026-07-05',
			count: limit,
		},
	])
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_sends_per_day',
			now,
		}),
	).rejects.toBeInstanceOf(EntitlementLimitError)

	const denied = await consumeDailyEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'email_sends_per_day',
		now,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'email_sends_per_day',
		plan: 'personal',
		limit,
		current: limit,
	})
	expect(counters[0]?.count).toBe(limit)

	const nextDay = new Date('2026-07-06T00:00:01.000Z')
	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'email_sends_per_day',
		now: nextDay,
	})
	await consumeDailyEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'email_sends_per_day',
		now: nextDay,
	})
	expect(counters).toHaveLength(2)
	expect(counters[1]?.count).toBe(1)
})

test('plan-less users count uncapped sends but honor fallback receive limits', async () => {
	const { db, counters } = createEntitlementsTestDb()
	const sendLimit = planLimits.personal.maxEmailSendsPerDay
	if (sendLimit === null)
		throw new Error('Expected a numeric email send limit.')
	const now = new Date('2026-07-05T15:00:00.000Z')
	for (let index = 0; index < sendLimit + 1; index += 1) {
		await consumeDailyEntitlement({
			db,
			userId: 'user-1',
			email: null,
			resource: 'email_sends_per_day',
			now,
		})
	}
	expect(counters[0]?.count).toBe(sendLimit + 1)

	const fallbackLimit = nullPlanEmailFallbackLimits.email_receives_per_day
	for (let index = 0; index < fallbackLimit; index += 1) {
		await consumeDailyEntitlement({
			db,
			userId: 'user-1',
			email: null,
			resource: 'email_receives_per_day',
			fallbackLimit,
			now,
		})
	}
	expect(
		counters.find((row) => row.resource === 'email_receives_per_day')?.count,
	).toBe(fallbackLimit)

	const denied = await consumeDailyEntitlement({
		db,
		userId: 'user-1',
		email: null,
		resource: 'email_receives_per_day',
		fallbackLimit,
		now,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'email_receives_per_day',
		plan: null,
		limit: fallbackLimit,
		current: fallbackLimit,
	})
})

test('consumeDailyEntitlement prefers the plan limit over fallbackLimit', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db, counters } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'personal' }],
	})
	const limit = planLimits.personal.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric email send limit.')
	const now = new Date('2026-07-05T15:00:00.000Z')
	for (let index = 0; index < limit; index += 1) {
		await consumeDailyEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_sends_per_day',
			fallbackLimit: 1,
			now,
		})
	}
	expect(counters[0]?.count).toBe(limit)
	await expect(
		consumeDailyEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_sends_per_day',
			fallbackLimit: 1,
			now,
		}),
	).rejects.toBeInstanceOf(EntitlementLimitError)
})

test('email_message_bytes enforces the per-message size via getCurrent', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'personal' }],
	})
	const maxBytes = planLimits.personal.maxEmailMessageBytes
	if (maxBytes === null) throw new Error('Expected a numeric size cap.')
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_message_bytes',
			requested: 0,
			getCurrent: async () => maxBytes + 1,
		}),
	).rejects.toThrow(`at most ${maxBytes} bytes per email message`)
	// A message exactly at the cap passes.
	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'email_message_bytes',
		requested: 0,
		getCurrent: async () => maxBytes,
	})
	// The per-message resource has no accumulating counter.
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_message_bytes',
		}),
	).rejects.toThrow('pass getCurrent')
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'storage_bytes',
		}),
	).rejects.toThrow('pass getCurrent')
})

test('requested units and getCurrent overrides are honored', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'personal' }],
	})
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'saved_packages',
			requested: 5,
			getCurrent: async () => 17,
		}),
	).rejects.toThrow('at most 20 saved packages')
	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'saved_packages',
		requested: 3,
		getCurrent: async () => 17,
	})
})
