import { expect, test } from 'vitest'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	EntitlementLimitError,
	buildEntitlementLimitMessage,
	buildEntitlementUpgradeHint,
	parseEntitlementLimitMessage,
} from './errors.ts'
import {
	getPlanRank,
	maxPlanEmailLimits,
	parsePlanName,
	parseStoredPlanName,
	parseStripePlanName,
	planLimits,
	planNames,
	resolveEffectivePlan,
	resolvePlanLimit,
	resolvePlanWrite,
	unknownStoredPlanWarningTag,
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

test('entitlement limit messages always identify a known plan name', () => {
	const details = {
		code: 'entitlement_limit_exceeded' as const,
		resource: 'concurrent_workflows' as const,
		plan: 'max' as const,
		limit: 100,
		current: 100,
		upgradeHint: buildEntitlementUpgradeHint('concurrent_workflows'),
	}
	const message = buildEntitlementLimitMessage(details)
	expect(message).toContain('your "max" plan')
	expect(message).toContain('/account/billing')
	expect(message).not.toContain('ask the operator')
	expect(message).not.toContain('this deployment')
	expect(parseEntitlementLimitMessage(message)).toEqual(details)
	expect(
		parseEntitlementLimitMessage(
			'Plan limit reached: this deployment allows at most 100 concurrent workflows and you currently have 100. hint',
		),
	).toBeNull()
	expect(
		parseEntitlementLimitMessage(
			'Plan limit reached: your "enterprise" plan allows at most 100 concurrent workflows and you currently have 100. hint',
		),
	).toBeNull()
})

test('parsePlanName accepts registered plan names and treats everything else as null', () => {
	for (const plan of planNames) {
		expect(parsePlanName(plan)).toBe(plan)
	}
	expect(parsePlanName('unlimited')).toBeNull()
	expect(parsePlanName('enterprise')).toBeNull()
	expect(parsePlanName(' pro ')).toBeNull()
	expect(parsePlanName('')).toBeNull()
	expect(parsePlanName(null)).toBeNull()
	expect(parsePlanName(undefined)).toBeNull()
	expect(parsePlanName(1)).toBeNull()
})

test('parseStoredPlanName keeps known plans and fails open unknown/null/residual unlimited to max with a stable warn', () => {
	consoleWarn.mockImplementation(() => {})
	for (const plan of planNames) {
		expect(parseStoredPlanName(plan)).toBe(plan)
	}
	expect(consoleWarn).not.toHaveBeenCalled()

	expect(parseStoredPlanName('enterprise-2099')).toBe('max')
	expect(parseStoredPlanName(null)).toBe('max')
	expect(parseStoredPlanName(undefined)).toBe('max')
	expect(parseStoredPlanName('')).toBe('max')
	expect(parseStoredPlanName(' pro ')).toBe('max')
	expect(parseStoredPlanName(1)).toBe('max')
	expect(parseStoredPlanName('unlimited')).toBe('max')
	expect(consoleWarn).toHaveBeenCalledTimes(7)
	for (const call of consoleWarn.mock.calls) {
		expect(call).toEqual([unknownStoredPlanWarningTag])
	}
})

test('parseStripePlanName rejects max, unlimited, and unknown values', () => {
	expect(parseStripePlanName('pro')).toBe('pro')
	expect(parseStripePlanName('max')).toBeNull()
	expect(parseStripePlanName('unlimited')).toBeNull()
	expect(parseStripePlanName('enterprise')).toBeNull()
	expect(parseStripePlanName(null)).toBeNull()
})

test('resolvePlanWrite maps nullish inputs to free', () => {
	expect(resolvePlanWrite(null)).toBe('free')
	expect(resolvePlanWrite(undefined)).toBe('free')
	expect(resolvePlanWrite('pro')).toBe('pro')
	expect(resolvePlanWrite('max')).toBe('max')
	expect(resolvePlanWrite('free')).toBe('free')
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

test('getUserPlan resolves plans via email+stable id and short-circuits invalid lookups to max', async () => {
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
	expect(await getUserPlan(db, { userId: 'user-1', email: null })).toBe('max')
	expect(await getUserPlan(db, { userId: 'user-1', email: '' })).toBe('max')
	expect(await getUserPlan(db, { userId: 'user-1', email: plannedEmail })).toBe(
		'max',
	)
	expect(queries).toEqual([])
	expect(consoleWarn).not.toHaveBeenCalled()

	expect(await getUserPlan(db, { userId, email: plannedEmail })).toBe('pro')
	expect(
		await getUserPlan(db, { userId, email: ' Planned@Example.com ' }),
	).toBe('pro')
	expect(queries.at(-1)?.sql).toContain('email = ? AND stable_user_id = ?')
	expect(queries.at(-1)?.params).toEqual([plannedEmail, userId])

	// Mismatched email/stable-id pair is intentionally max (no warn).
	expect(
		await getUserPlan(db, {
			userId,
			email: unknownPlanEmail,
		}),
	).toBe('max')
	expect(consoleWarn).not.toHaveBeenCalled()

	consoleWarn.mockImplementation(() => {})
	expect(
		await getUserPlan(db, {
			userId: unknownPlanUserId,
			email: unknownPlanEmail,
		}),
	).toBe('max')
	expect(consoleWarn).toHaveBeenCalledWith(unknownStoredPlanWarningTag)
})

test('assertWithinEntitlement passes under the limit, throws at it, and enforces finite max ordinary limits', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const freeLimit = planLimits.free.maxScheduledJobs
	const maxLimit = planLimits.max.maxScheduledJobs

	const maxUnder = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
		counts: { jobs: maxLimit - 1 },
	})
	await assertWithinEntitlement({
		db: maxUnder.db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})

	const maxAt = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
		counts: { jobs: maxLimit },
	})
	const maxDenied = await assertWithinEntitlement({
		db: maxAt.db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(maxDenied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError for max plan.')
	}
	expect(maxDenied.details).toMatchObject({
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})

	const under = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
		counts: { jobs: freeLimit - 1 },
	})
	await assertWithinEntitlement({
		db: under.db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})

	const at = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
		counts: { jobs: freeLimit },
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
		limit: freeLimit,
		current: freeLimit,
		upgradeHint: error.details.upgradeHint,
	})
	expect(error.message).toBe(buildEntitlementLimitMessage(error.details))
})

test('assertWithinEntitlement enforces max concurrent workflow limit without email', async () => {
	const maxLimit = planLimits.max.maxConcurrentWorkflows
	const { db } = createEntitlementsTestDb({
		counts: { workflow_runs: maxLimit },
	})
	const error = await assertWithinEntitlement({
		db,
		userId: 'user-1',
		email: null,
		resource: 'concurrent_workflows',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(error.details).toMatchObject({
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
})

test('persistent package services are gated as a 0/1 limit', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	expect(resolvePlanLimit('free', 'persistent_package_services')).toBe(0)
	expect(resolvePlanLimit('pro', 'persistent_package_services')).toBe(1)

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

test('missing-email lookups resolve to max and honor max email caps', async () => {
	const { db, counters } = createEntitlementsTestDb()
	const sendLimit = maxPlanEmailLimits.email_sends_per_day
	const now = new Date('2026-07-05T15:00:00.000Z')
	for (let index = 0; index < sendLimit; index += 1) {
		await consumeDailyEntitlement({
			db,
			userId: 'user-1',
			email: null,
			resource: 'email_sends_per_day',
			now,
		})
	}
	expect(counters[0]?.count).toBe(sendLimit)
	await expect(
		consumeDailyEntitlement({
			db,
			userId: 'user-1',
			email: null,
			resource: 'email_sends_per_day',
			now,
		}),
	).rejects.toBeInstanceOf(EntitlementLimitError)

	const receiveLimit = maxPlanEmailLimits.email_receives_per_day
	for (let index = 0; index < receiveLimit; index += 1) {
		await consumeDailyEntitlement({
			db,
			userId: 'user-1',
			email: null,
			resource: 'email_receives_per_day',
			now,
		})
	}
	expect(
		counters.find((row) => row.resource === 'email_receives_per_day')?.count,
	).toBe(receiveLimit)

	const denied = await consumeDailyEntitlement({
		db,
		userId: 'user-1',
		email: null,
		resource: 'email_receives_per_day',
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
		plan: 'max',
		limit: receiveLimit,
		current: receiveLimit,
	})
	expect(consoleWarn).not.toHaveBeenCalled()
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

test('storage bytes enforce for planned users and enforce finite max storage caps', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const proLimit = planLimits.pro.maxStorageBytes
	const maxLimit = planLimits.max.maxStorageBytes

	const maxAt = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
		counts: { email_messages: maxLimit },
	})
	const maxDenied = await assertWithinStorageBytesEntitlement({
		db: maxAt.db,
		userId,
		email: plannedEmail,
		requested: 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(maxDenied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError for max storage.')
	}
	expect(maxDenied.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'storage_bytes',
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})

	const atLimit = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
		counts: { email_messages: proLimit },
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
		limit: proLimit,
		current: proLimit,
	})

	const underLimit = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
		counts: { email_messages: proLimit - 1 },
	})
	await assertWithinStorageBytesEntitlement({
		db: underLimit.db,
		userId,
		email: plannedEmail,
		requested: 1,
	})
})

test('getPlanRank orders free < pro < partner < max', () => {
	expect(getPlanRank('free')).toBeLessThan(getPlanRank('pro'))
	expect(getPlanRank('pro')).toBeLessThan(getPlanRank('partner'))
	expect(getPlanRank('partner')).toBeLessThan(getPlanRank('max'))
})

test('resolveEffectivePlan manual max ranks above Stripe', () => {
	expect(resolveEffectivePlan('max', 'pro')).toBe('max')
	expect(resolveEffectivePlan('max', 'partner')).toBe('max')
	expect(resolveEffectivePlan('max', null)).toBe('max')
})

test('resolveEffectivePlan picks the higher of manual and stripe plans', () => {
	expect(resolveEffectivePlan('free', 'pro')).toBe('pro')
	expect(resolveEffectivePlan('pro', 'free')).toBe('pro')
	expect(resolveEffectivePlan('free', 'partner')).toBe('partner')
	expect(resolveEffectivePlan('partner', 'pro')).toBe('partner')
	expect(resolveEffectivePlan('pro', null)).toBe('pro')
	expect(resolveEffectivePlan('pro', 'not-a-plan')).toBe('pro')
	expect(resolveEffectivePlan('pro', 'personal')).toBe('pro')
	// Stripe cannot source max or residual unlimited.
	expect(resolveEffectivePlan('free', 'max')).toBe('free')
	expect(resolveEffectivePlan('free', 'unlimited')).toBe('free')
})

test('free plan limits are stricter than pro', () => {
	expect(planLimits.free.maxSavedPackages).toBe(5)
	expect(planLimits.free.maxScheduledJobs).toBe(3)
	expect(planLimits.free.maxPackageServices).toBe(1)
	expect(planLimits.free.packageServicePersistentAllowed).toBe(0)
	expect(planLimits.free.maxSavedPackages).toBeLessThan(
		planLimits.pro.maxSavedPackages,
	)
	expect(planLimits.free.maxScheduledJobs).toBeLessThan(
		planLimits.pro.maxScheduledJobs,
	)
	expect(resolvePlanLimit('free', 'persistent_package_services')).toBe(0)
	expect(resolvePlanLimit('free', 'saved_packages')).toBe(5)
})

test('max plan has finite ordinary limits, email caps, and persistent services', () => {
	expect(planLimits.max.maxSavedPackages).toBe(10_000)
	expect(planLimits.max.maxScheduledJobs).toBe(5_000)
	expect(planLimits.max.maxPackageServices).toBe(1_000)
	expect(planLimits.max.maxRepoSessions).toBe(2_000)
	expect(planLimits.max.maxSecrets).toBe(10_000)
	expect(planLimits.max.maxStorageBytes).toBe(100 * 1024 * 1024 * 1024)
	expect(planLimits.max.maxConcurrentWorkflows).toBe(5_000)
	expect(planLimits.max.packageServicePersistentAllowed).toBe(1)
	expect(resolvePlanLimit('max', 'persistent_package_services')).toBe(1)
	expect(planLimits.max.maxEmailSendsPerDay).toBe(
		maxPlanEmailLimits.email_sends_per_day,
	)
	expect(planLimits.max.maxEmailReceivesPerDay).toBe(
		maxPlanEmailLimits.email_receives_per_day,
	)
	expect(planLimits.max.maxStoredEmailMessages).toBe(
		maxPlanEmailLimits.stored_email_messages,
	)
	expect(planLimits.max.maxEmailMessageBytes).toBe(
		maxPlanEmailLimits.email_message_bytes,
	)
})

test('unexpected stored NULL, unknown, and residual unlimited coerce to max finite limits', async () => {
	const defensiveNullEmail = 'unexpected-stored-null@example.com'
	const unknownPlanEmail = 'unknown-plan@example.com'
	const residualUnlimitedEmail = 'residual-unlimited@example.com'
	const defensiveNullUserId =
		await createStableUserIdFromEmail(defensiveNullEmail)
	const unknownPlanUserId = await createStableUserIdFromEmail(unknownPlanEmail)
	const residualUnlimitedUserId = await createStableUserIdFromEmail(
		residualUnlimitedEmail,
	)
	const maxJobLimit = planLimits.max.maxScheduledJobs
	const maxWorkflowLimit = planLimits.max.maxConcurrentWorkflows

	silenceExpectedConsoleWarns([unknownStoredPlanWarningTag])

	const defensiveNull = createEntitlementsTestDb({
		users: [
			{
				email: defensiveNullEmail,
				plan: null,
				stable_user_id: defensiveNullUserId,
			},
		],
		counts: { jobs: maxJobLimit },
	})
	const defensiveNullDenied = await assertWithinEntitlement({
		db: defensiveNull.db,
		userId: defensiveNullUserId,
		email: defensiveNullEmail,
		resource: 'scheduled_jobs',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(defensiveNullDenied instanceof EntitlementLimitError)) {
		throw new Error('Expected denial for coerced-null max job limit.')
	}
	expect(defensiveNullDenied.details).toMatchObject({
		plan: 'max',
		limit: maxJobLimit,
		current: maxJobLimit,
	})

	const unknownPlan = createEntitlementsTestDb({
		users: [
			{
				email: unknownPlanEmail,
				plan: 'enterprise-2099',
				stable_user_id: unknownPlanUserId,
			},
		],
		counts: { jobs: maxJobLimit },
	})
	const unknownDenied = await assertWithinEntitlement({
		db: unknownPlan.db,
		userId: unknownPlanUserId,
		email: unknownPlanEmail,
		resource: 'scheduled_jobs',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(unknownDenied instanceof EntitlementLimitError)) {
		throw new Error('Expected denial for coerced-unknown max job limit.')
	}
	expect(unknownDenied.details).toMatchObject({
		plan: 'max',
		limit: maxJobLimit,
	})

	const residualUnlimited = createEntitlementsTestDb({
		users: [
			{
				email: residualUnlimitedEmail,
				plan: 'unlimited',
				stable_user_id: residualUnlimitedUserId,
			},
		],
		counts: { jobs: maxJobLimit },
	})
	const residualDenied = await assertWithinEntitlement({
		db: residualUnlimited.db,
		userId: residualUnlimitedUserId,
		email: residualUnlimitedEmail,
		resource: 'scheduled_jobs',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(residualDenied instanceof EntitlementLimitError)) {
		throw new Error('Expected denial for residual-unlimited→max job limit.')
	}
	expect(residualDenied.details).toMatchObject({
		plan: 'max',
		limit: maxJobLimit,
		current: maxJobLimit,
	})

	const concurrent = createEntitlementsTestDb({
		users: [
			{
				email: residualUnlimitedEmail,
				plan: 'unlimited',
				stable_user_id: residualUnlimitedUserId,
			},
		],
		counts: { workflow_runs: maxWorkflowLimit },
	})
	const error = await assertWithinEntitlement({
		db: concurrent.db,
		userId: residualUnlimitedUserId,
		email: residualUnlimitedEmail,
		resource: 'concurrent_workflows',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(error.details).toMatchObject({
		plan: 'max',
		limit: maxWorkflowLimit,
		current: maxWorkflowLimit,
	})
	expect(
		concurrent.queries.some((query) =>
			query.sql.includes('FROM workflow_runs'),
		),
	).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(unknownStoredPlanWarningTag)
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
				plan: 'max',
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
	consoleWarn.mockImplementation(() => {})
	// Stored NULL fails open to max (which ranks above Stripe).
	expect(
		await getUserPlan(db, {
			userId: nullPlusProUserId,
			email: nullPlusProEmail,
		}),
	).toBe('max')
	expect(consoleWarn).toHaveBeenCalledWith(unknownStoredPlanWarningTag)
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
	).toBe('max')
})
