import { expect, test, vi } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	EntitlementLimitError,
	buildEntitlementLimitMessage,
} from './errors.ts'
import {
	getPlanRank,
	nullPlanEmailFallbackLimits,
	parsePlanName,
	parseStripePlanName,
	planLimits,
	planNames,
	resolveEffectivePlan,
	resolvePlanLimit,
	resolvePlanWrite,
} from './plans.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	estimateEntitlementStorageEntryByteDelta,
	estimateEntitlementStorageEntryBytes,
	getUserPlan,
	incrementDailyEntitlementCounter,
	refundDailyEntitlement,
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
		users?: Array<{
			email: string
			plan: string | null
			stripe_plan?: string | null
			stable_user_id: string
		}>
		counts?: Partial<
			Record<
				| 'saved_packages'
				| 'jobs'
				| 'repo_sessions'
				| 'package_runtime_runs'
				| 'package_runtime_logs'
				| 'package_invocations'
				| 'published_bundle_artifacts'
				| 'secret_entries'
				| 'value_entries'
				| 'mcp_memories'
				| 'saved_packages'
				| 'entity_sources'
				| 'email_messages'
				| 'email_attachments'
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
	const queries: Array<{ sql: string; params: Array<unknown> }> = []

	function countFor(query: string) {
		const tableNames = [
			'email_attachments',
			'email_messages',
			'value_entries',
			'secret_entries',
			'mcp_memories',
			'saved_packages',
			'entity_sources',
			'jobs',
			'repo_sessions',
			'package_invocations',
			'package_runtime_runs',
			'package_runtime_logs',
			'published_bundle_artifacts',
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
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql: query, params })
					return {
						async first<T>() {
							if (
								query.includes('SELECT plan, stripe_plan FROM users') ||
								query.includes('SELECT plan FROM users')
							) {
								const email = params[0]
								const stableUserId = params[1]
								// Pair match is required: omitted bind params or
								// email-only fixtures must not resolve a plan.
								if (
									typeof email !== 'string' ||
									typeof stableUserId !== 'string'
								) {
									return null as T | null
								}
								const user = users.find(
									(row) =>
										row.email === email && row.stable_user_id === stableUserId,
								)
								return (
									user
										? {
												plan: user.plan,
												stripe_plan: user.stripe_plan ?? null,
											}
										: null
								) as T | null
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
							if (query.includes('UPDATE entitlement_daily_counters')) {
								// bind(updated_at, user_id, resource, day)
								const existing = counters.find(
									(counter) =>
										counter.user_id === params[1] &&
										counter.resource === params[2] &&
										counter.day === params[3],
								)
								if (existing) {
									existing.count = Math.max(0, existing.count - 1)
									return { meta: { changes: 1 } }
								}
								return { meta: { changes: 0 } }
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

test('parsePlanName accepts registered plan names and treats everything else as null', () => {
	for (const plan of planNames) {
		expect(parsePlanName(plan)).toBe(plan)
	}
	expect(parsePlanName('enterprise')).toBeNull()
	expect(parsePlanName(' pro ')).toBeNull()
	expect(parsePlanName('')).toBeNull()
	expect(parsePlanName(null)).toBeNull()
	expect(parsePlanName(undefined)).toBeNull()
	expect(parsePlanName(1)).toBeNull()
})

test('parseStripePlanName rejects unlimited and unknown values', () => {
	expect(parseStripePlanName('pro')).toBe('pro')
	expect(parseStripePlanName('unlimited')).toBeNull()
	expect(parseStripePlanName('enterprise')).toBeNull()
	expect(parseStripePlanName(null)).toBeNull()
})

test('resolvePlanWrite maps nullish inputs to unlimited', () => {
	expect(resolvePlanWrite(null)).toBe('unlimited')
	expect(resolvePlanWrite(undefined)).toBe('unlimited')
	expect(resolvePlanWrite('pro')).toBe('pro')
	expect(resolvePlanWrite('unlimited')).toBe('unlimited')
})

test('storage byte entry estimates support net-positive upsert deltas', () => {
	const existing = {
		key: 'workspace',
		value: {
			description: 'Workspace slug',
			value: 'kent-main-site',
		},
	}
	expect(
		estimateEntitlementStorageEntryByteDelta({
			next: existing,
			existing,
		}),
	).toBe(0)
	expect(
		estimateEntitlementStorageEntryByteDelta({
			next: {
				key: 'workspace',
				value: {
					description: 'Workspace slug',
					value: 'kent',
				},
			},
			existing,
		}),
	).toBe(0)
	const growing = {
		key: 'workspace',
		value: {
			description: 'Workspace slug',
			value: 'kent-main-site-production',
		},
	}
	expect(
		estimateEntitlementStorageEntryByteDelta({
			next: growing,
			existing,
		}),
	).toBe(
		estimateEntitlementStorageEntryBytes(growing) -
			estimateEntitlementStorageEntryBytes(existing),
	)
})

test('getUserPlan resolves plans via email+stable id and short-circuits invalid lookups', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const unknownPlanEmail = 'unknown-plan@example.com'
	const unknownPlanUserId = await createStableUserIdFromEmail(unknownPlanEmail)
	const { db, queries } = createEntitlementsTestDb({
		users: [
			{ email: plannedEmail, plan: 'pro', stable_user_id: userId },
			{
				email: unknownPlanEmail,
				plan: 'enterprise-2099',
				stable_user_id: unknownPlanUserId,
			},
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
	expect(queries.at(-1)?.sql).toContain('email = ? AND stable_user_id = ?')
	expect(queries.at(-1)?.params).toEqual([plannedEmail, userId])

	// Mismatched email/stable-id pair is intentionally unlimited.
	expect(
		await getUserPlan(db, {
			userId,
			email: unknownPlanEmail,
		}),
	).toBeNull()

	expect(
		await getUserPlan(db, {
			userId: unknownPlanUserId,
			email: unknownPlanEmail,
		}),
	).toBeNull()
})

test('assertWithinEntitlement passes under the limit, throws at it, and skips counting without a plan', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const limit = planLimits.free.maxScheduledJobs
	if (limit === null) throw new Error('Expected a numeric free job limit.')

	const noPlan = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: null, stable_user_id: userId }],
		counts: { jobs: 10_000 },
	})
	await assertWithinEntitlement({
		db: noPlan.db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})
	expect(noPlan.queries).toHaveLength(1)
	expect(noPlan.queries[0]?.sql).toContain(
		'SELECT plan, stripe_plan FROM users',
	)

	const under = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
		counts: { jobs: limit - 1 },
	})
	await assertWithinEntitlement({
		db: under.db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})

	const at = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
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
	expect(error.details).toEqual({
		code: 'entitlement_limit_exceeded',
		resource: 'scheduled_jobs',
		plan: 'free',
		limit,
		current: limit,
		upgradeHint: error.details.upgradeHint,
	})
	expect(error.message).toBe(buildEntitlementLimitMessage(error.details))
})

test('assertWithinEntitlement applies fallbackLimit for stored-NULL dual-read users', async () => {
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
	expect(resolvePlanLimit('free', 'persistent_package_services')).toBe(0)
	expect(resolvePlanLimit('pro', 'persistent_package_services')).toBeNull()

	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
	})
	const denied = await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'persistent_package_services',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		resource: 'persistent_package_services',
		limit: 0,
	})

	const proDb = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
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
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
	})
	expect(utcDayKey(now)).toBe('2026-07-05')

	const limit = planLimits.free.maxEmailSendsPerDay
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
		fallbackLimit: 1,
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
		plan: 'free',
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

test('refundDailyEntitlement decrements the user/day counter and floors at zero', async () => {
	const { db, counters } = createEntitlementsTestDb()
	const now = new Date('2026-07-05T15:00:00.000Z')
	await incrementDailyEntitlementCounter({
		db,
		userId: 'user-1',
		resource: 'email_receives_per_day',
		amount: 2,
		now,
	})
	await incrementDailyEntitlementCounter({
		db,
		userId: 'user-2',
		resource: 'email_receives_per_day',
		amount: 3,
		now,
	})
	await refundDailyEntitlement({
		db,
		userId: 'user-1',
		resource: 'email_receives_per_day',
		now,
	})
	expect(
		counters.find(
			(row) =>
				row.user_id === 'user-1' && row.resource === 'email_receives_per_day',
		)?.count,
	).toBe(1)
	expect(
		counters.find(
			(row) =>
				row.user_id === 'user-2' && row.resource === 'email_receives_per_day',
		)?.count,
	).toBe(3)

	await refundDailyEntitlement({
		db,
		userId: 'user-1',
		resource: 'email_receives_per_day',
		now,
	})
	await refundDailyEntitlement({
		db,
		userId: 'user-1',
		resource: 'email_receives_per_day',
		now,
	})
	expect(
		counters.find(
			(row) =>
				row.user_id === 'user-1' && row.resource === 'email_receives_per_day',
		)?.count,
	).toBe(0)
})

test('stored-NULL dual-read users count uncapped sends but honor fallback receive limits', async () => {
	const { db, counters } = createEntitlementsTestDb()
	const sendLimit = planLimits.free.maxEmailSendsPerDay
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

test('requested units and getCurrent overrides are honored', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
	})
	const maxBytes = planLimits.pro.maxEmailMessageBytes
	if (maxBytes === null) throw new Error('Expected a numeric size cap.')

	const oversized = await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'email_message_bytes',
		requested: 0,
		getCurrent: async () => maxBytes + 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(oversized instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(oversized.details).toMatchObject({
		resource: 'email_message_bytes',
		limit: maxBytes,
	})

	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'email_message_bytes',
		requested: 0,
		getCurrent: async () => maxBytes,
	})
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_message_bytes',
		}),
	).rejects.toThrow('pass getCurrent')

	const overSavedPackages = await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'saved_packages',
		requested: 5,
		getCurrent: async () => 97,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(overSavedPackages instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(overSavedPackages.details).toMatchObject({
		resource: 'saved_packages',
		limit: 100,
		current: 97,
	})
	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'saved_packages',
		requested: 3,
		getCurrent: async () => 97,
	})
})

test('storage bytes enforce for planned users and skip stored-NULL dual-read users', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const limit = planLimits.pro.maxStorageBytes
	if (limit === null) throw new Error('Expected a numeric pro storage cap.')

	const noPlan = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: null, stable_user_id: userId }],
		counts: { email_messages: limit + 1 },
	})
	await assertWithinStorageBytesEntitlement({
		db: noPlan.db,
		userId,
		email: plannedEmail,
		requested: 1,
	})
	expect(noPlan.queries).toHaveLength(1)
	expect(noPlan.queries[0]?.sql).toContain(
		'SELECT plan, stripe_plan FROM users',
	)

	const atLimit = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
		counts: { email_messages: limit },
	})
	const denied = await assertWithinStorageBytesEntitlement({
		db: atLimit.db,
		userId,
		email: plannedEmail,
		requested: 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'storage_bytes',
		plan: 'pro',
		limit,
		current: limit,
	})

	const underLimit = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
		counts: { email_messages: limit - 1 },
	})
	await assertWithinStorageBytesEntitlement({
		db: underLimit.db,
		userId,
		email: plannedEmail,
		requested: 1,
	})
})

test('getPlanRank orders free < pro < partner < unlimited', () => {
	expect(getPlanRank('free')).toBeLessThan(getPlanRank('pro'))
	expect(getPlanRank('pro')).toBeLessThan(getPlanRank('partner'))
	expect(getPlanRank('partner')).toBeLessThan(getPlanRank('unlimited'))
})

test('resolveEffectivePlan never downgrades a NULL manual plan', () => {
	expect(resolveEffectivePlan(null, 'pro')).toBeNull()
	expect(resolveEffectivePlan(null, 'partner')).toBeNull()
	expect(resolveEffectivePlan(null, null)).toBeNull()
	expect(resolveEffectivePlan(null, 'unknown')).toBeNull()
})

test('resolveEffectivePlan manual unlimited always beats Stripe', () => {
	expect(resolveEffectivePlan('unlimited', 'pro')).toBe('unlimited')
	expect(resolveEffectivePlan('unlimited', 'partner')).toBe('unlimited')
	expect(resolveEffectivePlan('unlimited', 'unlimited')).toBe('unlimited')
	expect(resolveEffectivePlan('unlimited', null)).toBe('unlimited')
})

test('resolveEffectivePlan picks the higher of manual and stripe plans', () => {
	expect(resolveEffectivePlan('free', 'pro')).toBe('pro')
	expect(resolveEffectivePlan('pro', 'free')).toBe('pro')
	expect(resolveEffectivePlan('free', 'partner')).toBe('partner')
	expect(resolveEffectivePlan('partner', 'pro')).toBe('partner')
	expect(resolveEffectivePlan('pro', null)).toBe('pro')
	expect(resolveEffectivePlan('pro', 'not-a-plan')).toBe('pro')
	expect(resolveEffectivePlan('pro', 'personal')).toBe('pro')
	expect(resolveEffectivePlan('free', 'unlimited')).toBe('free')
})

test('free plan limits are stricter than pro', () => {
	expect(planLimits.free.maxSavedPackages).toBe(5)
	expect(planLimits.free.maxScheduledJobs).toBe(3)
	expect(planLimits.free.maxPackageServices).toBe(1)
	expect(planLimits.free.packageServicePersistentAllowed).toBe(false)
	expect(planLimits.free.maxSavedPackages).toBeLessThan(
		planLimits.pro.maxSavedPackages!,
	)
	expect(planLimits.free.maxScheduledJobs).toBeLessThan(
		planLimits.pro.maxScheduledJobs!,
	)
	expect(resolvePlanLimit('free', 'persistent_package_services')).toBe(0)
	expect(resolvePlanLimit('free', 'saved_packages')).toBe(5)
})

test('unlimited plan has null ordinary limits, email fallbacks, and persistent services', () => {
	expect(planLimits.unlimited.maxSavedPackages).toBeNull()
	expect(planLimits.unlimited.maxScheduledJobs).toBeNull()
	expect(planLimits.unlimited.maxPackageServices).toBeNull()
	expect(planLimits.unlimited.maxRepoSessions).toBeNull()
	expect(planLimits.unlimited.maxSecrets).toBeNull()
	expect(planLimits.unlimited.maxStorageBytes).toBeNull()
	expect(planLimits.unlimited.maxConcurrentWorkflows).toBeNull()
	expect(planLimits.unlimited.packageServicePersistentAllowed).toBe(true)
	expect(
		resolvePlanLimit('unlimited', 'persistent_package_services'),
	).toBeNull()
	expect(planLimits.unlimited.maxEmailSendsPerDay).toBe(
		nullPlanEmailFallbackLimits.email_sends_per_day,
	)
	expect(planLimits.unlimited.maxEmailReceivesPerDay).toBe(
		nullPlanEmailFallbackLimits.email_receives_per_day,
	)
	expect(planLimits.unlimited.maxStoredEmailMessages).toBe(
		nullPlanEmailFallbackLimits.stored_email_messages,
	)
	expect(planLimits.unlimited.maxEmailMessageBytes).toBe(
		nullPlanEmailFallbackLimits.email_message_bytes,
	)
})

test('stored unlimited matches stored-NULL ordinary fail-open and still uses concurrent_workflows fallbackLimit', async () => {
	const nullPlanEmail = 'null-plan@example.com'
	const unlimitedEmail = 'unlimited-plan@example.com'
	const nullPlanUserId = await createStableUserIdFromEmail(nullPlanEmail)
	const unlimitedUserId = await createStableUserIdFromEmail(unlimitedEmail)

	const nullPlanGetCurrent = vi.fn(async () => 10_000)
	const nullPlan = createEntitlementsTestDb({
		users: [
			{ email: nullPlanEmail, plan: null, stable_user_id: nullPlanUserId },
		],
		counts: { jobs: 10_000 },
	})
	await assertWithinEntitlement({
		db: nullPlan.db,
		userId: nullPlanUserId,
		email: nullPlanEmail,
		resource: 'scheduled_jobs',
		getCurrent: nullPlanGetCurrent,
	})
	expect(nullPlanGetCurrent).not.toHaveBeenCalled()
	expect(nullPlan.queries).toHaveLength(1)
	expect(nullPlan.queries[0]?.sql).toContain(
		'SELECT plan, stripe_plan FROM users',
	)

	const unlimitedGetCurrent = vi.fn(async () => 10_000)
	const unlimited = createEntitlementsTestDb({
		users: [
			{
				email: unlimitedEmail,
				plan: 'unlimited',
				stable_user_id: unlimitedUserId,
			},
		],
		counts: { jobs: 10_000 },
	})
	await assertWithinEntitlement({
		db: unlimited.db,
		userId: unlimitedUserId,
		email: unlimitedEmail,
		resource: 'scheduled_jobs',
		getCurrent: unlimitedGetCurrent,
	})
	expect(unlimitedGetCurrent).not.toHaveBeenCalled()
	expect(unlimited.queries).toHaveLength(1)
	expect(unlimited.queries[0]?.sql).toContain(
		'SELECT plan, stripe_plan FROM users',
	)
	expect(unlimited.queries[0]?.params).toEqual([
		unlimitedEmail,
		unlimitedUserId,
	])

	const concurrent = createEntitlementsTestDb({
		users: [
			{
				email: unlimitedEmail,
				plan: 'unlimited',
				stable_user_id: unlimitedUserId,
			},
		],
		counts: { workflow_runs: 100 },
	})
	const error = await assertWithinEntitlement({
		db: concurrent.db,
		userId: unlimitedUserId,
		email: unlimitedEmail,
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
		plan: 'unlimited',
		limit: 100,
		current: 100,
	})
	expect(
		concurrent.queries.some((query) =>
			query.sql.includes('FROM workflow_runs'),
		),
	).toBe(true)
})

test('getUserPlan resolves effective plan from manual plan and stripe_plan', async () => {
	const freePlusProEmail = 'manual-free-stripe-pro@example.com'
	const nullPlusProEmail = 'manual-null-stripe-pro@example.com'
	const proPlusPartnerEmail = 'manual-pro-stripe-partner@example.com'
	const unlimitedPlusProEmail = 'manual-unlimited-stripe-pro@example.com'
	const freePlusProUserId = await createStableUserIdFromEmail(freePlusProEmail)
	const nullPlusProUserId = await createStableUserIdFromEmail(nullPlusProEmail)
	const proPlusPartnerUserId =
		await createStableUserIdFromEmail(proPlusPartnerEmail)
	const unlimitedPlusProUserId = await createStableUserIdFromEmail(
		unlimitedPlusProEmail,
	)
	const { db } = createEntitlementsTestDb({
		users: [
			{
				email: freePlusProEmail,
				plan: 'free',
				stripe_plan: 'pro',
				stable_user_id: freePlusProUserId,
			},
			{
				email: nullPlusProEmail,
				plan: null,
				stripe_plan: 'pro',
				stable_user_id: nullPlusProUserId,
			},
			{
				email: proPlusPartnerEmail,
				plan: 'pro',
				stripe_plan: 'partner',
				stable_user_id: proPlusPartnerUserId,
			},
			{
				email: unlimitedPlusProEmail,
				plan: 'unlimited',
				stripe_plan: 'pro',
				stable_user_id: unlimitedPlusProUserId,
			},
		],
	})

	expect(
		await getUserPlan(db, {
			userId: freePlusProUserId,
			email: freePlusProEmail,
		}),
	).toBe('pro')
	expect(
		await getUserPlan(db, {
			userId: nullPlusProUserId,
			email: nullPlusProEmail,
		}),
	).toBeNull()
	expect(
		await getUserPlan(db, {
			userId: proPlusPartnerUserId,
			email: proPlusPartnerEmail,
		}),
	).toBe('partner')
	expect(
		await getUserPlan(db, {
			userId: unlimitedPlusProUserId,
			email: unlimitedPlusProEmail,
		}),
	).toBe('unlimited')
})
