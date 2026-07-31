import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	EntitlementLimitError,
	buildEntitlementLimitMessage,
	buildEntitlementUpgradeHint,
	parseEntitlementLimitMessage,
} from './errors.ts'
import {
	entitlementResources,
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
} from './plans.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	countRunningPackageServices,
	estimateEntitlementStorageEntryByteDelta,
	estimateEntitlementStorageEntryBytes,
	findCachedUserAccountByStableUserId,
	getCachedUserPlan,
	getUserPlan,
	incrementDailyEntitlementCounter,
	packageServiceStateStaleMs,
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
	const initialStorageBytes = Object.values(counts).reduce(
		(total, count) => total + (count ?? 0),
		0,
	)
	const storageBytesByUser = new Map(
		users.map((user) => [user.stable_user_id, initialStorageBytes]),
	)

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
								const isPairLookup = query.includes('email = ?')
								if (isPairLookup) {
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
											row.email === email &&
											row.stable_user_id === stableUserId,
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
								const stableUserId = params[0]
								if (typeof stableUserId !== 'string') {
									return null as T | null
								}
								const user = users.find(
									(row) => row.stable_user_id === stableUserId,
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
							if (query.includes('SELECT email, plan, email_verified_at')) {
								const stableUserId = params[0]
								const user = users.find(
									(row) => row.stable_user_id === stableUserId,
								)
								return (
									user
										? {
												email: user.email,
												plan: user.plan,
												email_verified_at: null,
											}
										: null
								) as T | null
							}
							if (query.includes('SELECT d1_storage_bytes AS bytes')) {
								const bytes = storageBytesByUser.get(String(params[0]))
								return (bytes === undefined ? null : { bytes }) as T | null
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
							if (
								query.includes('SET d1_storage_bytes = d1_storage_bytes + ?')
							) {
								const userId = String(params[2])
								const existing = storageBytesByUser.get(userId)
								if (
									existing === undefined ||
									existing + Number(params[3]) > Number(params[4])
								) {
									return { meta: { changes: 0 } }
								}
								storageBytesByUser.set(userId, existing + Number(params[0]))
								return { meta: { changes: 1 } }
							}
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

test('parseStoredPlanName keeps known plans and throws for storage-contract violations', () => {
	for (const plan of planNames) {
		expect(parseStoredPlanName(plan)).toBe(plan)
	}
	for (const invalid of [
		'enterprise-2099',
		null,
		undefined,
		'',
		' pro ',
		1,
		'unlimited',
	]) {
		expect(() => parseStoredPlanName(invalid)).toThrow(
			'Stored plan is not a registered plan name.',
		)
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

test('getUserPlan resolves plans, defaults unresolved contexts to free, and rejects invalid stored plans', async () => {
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
	expect(await getUserPlan(db, { userId: 'user-1', email: null })).toBe('free')
	expect(await getUserPlan(db, { userId: 'user-1', email: '' })).toBe('free')
	expect(await getUserPlan(db, { userId: 'user-1', email: plannedEmail })).toBe(
		'free',
	)
	expect(queries).toEqual([])

	expect(await getUserPlan(db, { userId, email: plannedEmail })).toBe('pro')
	expect(
		await getUserPlan(db, { userId, email: ' Planned@Example.com ' }),
	).toBe('pro')
	expect(queries.at(-1)?.sql).toContain('email = ? AND stable_user_id = ?')
	expect(queries.at(-1)?.params).toEqual([plannedEmail, userId])

	// Package-job / workflow contexts persist email: '' — reverse-resolve by
	// stable userId so entitlement checks use the real plan (not free).
	expect(await getUserPlan(db, { userId, email: null })).toBe('pro')
	expect(await getUserPlan(db, { userId, email: '' })).toBe('pro')
	expect(await getUserPlan(db, { userId, email: '   ' })).toBe('pro')
	expect(queries.at(-1)?.sql).toContain('FROM users WHERE stable_user_id = ?')
	expect(queries.at(-1)?.params).toEqual([userId])

	// Mismatched email/stable-id pairs fail closed without warning.
	expect(
		await getUserPlan(db, {
			userId,
			email: unknownPlanEmail,
		}),
	).toBe('free')

	await expect(
		getUserPlan(db, {
			userId: unknownPlanUserId,
			email: unknownPlanEmail,
		}),
	).rejects.toThrow('Stored plan is not a registered plan name.')
})

test('getCachedUserPlan caches per db binding and never caches failures', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const users = [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }]
	const { db, queries } = createEntitlementsTestDb({ users })

	expect(await getCachedUserPlan(db, { userId, email: plannedEmail })).toBe(
		'pro',
	)
	expect(await getCachedUserPlan(db, { userId, email: plannedEmail })).toBe(
		'pro',
	)
	const planQueries = () =>
		queries.filter((query) =>
			query.sql.includes('email = ? AND stable_user_id = ?'),
		)
	expect(planQueries()).toHaveLength(1)

	// A plan change is visible to the uncached lookup immediately and to the
	// cached lookup only after the TTL: quota checks tolerate that staleness.
	users[0]!.plan = 'free'
	expect(await getUserPlan(db, { userId, email: plannedEmail })).toBe('free')
	expect(await getCachedUserPlan(db, { userId, email: plannedEmail })).toBe(
		'pro',
	)

	// Another db binding (fresh test database) never shares cache entries.
	const second = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
	})
	expect(
		await getCachedUserPlan(second.db, { userId, email: plannedEmail }),
	).toBe('free')

	// Anonymous / invalid ids short-circuit without touching the cache or D1.
	expect(await getCachedUserPlan(db, { userId, email: null })).toBe('free')
	expect(
		await getCachedUserPlan(db, { userId: 'user-1', email: plannedEmail }),
	).toBe('free')

	// Failures are not pinned for the TTL: the next call retries D1.
	let firstCall = true
	const flaky = {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							if (firstCall) {
								firstCall = false
								throw new Error('D1 blip')
							}
							return { plan: 'pro', stripe_plan: null }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	await expect(
		getCachedUserPlan(flaky, { userId, email: plannedEmail }),
	).rejects.toThrow('D1 blip')
	expect(await getCachedUserPlan(flaky, { userId, email: plannedEmail })).toBe(
		'pro',
	)
})

test('findCachedUserAccountByStableUserId caches the account reverse-resolution per db', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db, queries } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
	})
	const accountQueries = () =>
		queries.filter((query) =>
			query.sql.includes('SELECT email, plan, email_verified_at'),
		)
	expect(await findCachedUserAccountByStableUserId(db, userId)).toEqual({
		email: plannedEmail,
		plan: 'pro',
		emailVerified: false,
	})
	expect(await findCachedUserAccountByStableUserId(db, userId)).toEqual({
		email: plannedEmail,
		plan: 'pro',
		emailVerified: false,
	})
	expect(accountQueries()).toHaveLength(1)
	expect(await findCachedUserAccountByStableUserId(db, '  ')).toBeNull()
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

test('assertWithinEntitlement reuses cached plan within TTL while still enforcing usage', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const freeLimit = planLimits.free.maxScheduledJobs
	const counts = { jobs: freeLimit - 1 }
	const { db, queries } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
		counts,
	})
	const planQueries = () =>
		queries.filter((query) =>
			query.sql.includes('email = ? AND stable_user_id = ?'),
		)
	const usageQueries = () =>
		queries.filter((query) => query.sql.includes('FROM jobs'))

	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})
	await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	})
	expect(planQueries()).toHaveLength(1)
	expect(usageQueries()).toHaveLength(2)

	counts.jobs = freeLimit
	const denied = await assertWithinEntitlement({
		db,
		userId,
		email: plannedEmail,
		resource: 'scheduled_jobs',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})
	expect(planQueries()).toHaveLength(1)
	expect(usageQueries()).toHaveLength(3)
})

test('assertWithinEntitlement enforces free concurrent workflow limit without email', async () => {
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	const { db } = createEntitlementsTestDb({
		counts: { workflow_runs: freeLimit },
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
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})
})

test('assertWithinEntitlement reverse-resolves plan when email is blank for a real stable userId', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	const maxLimit = planLimits.max.maxConcurrentWorkflows
	const underMax = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
		counts: { workflow_runs: freeLimit },
	})
	await assertWithinEntitlement({
		db: underMax.db,
		userId,
		email: '',
		resource: 'concurrent_workflows',
	})

	const atMax = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
		counts: { workflow_runs: maxLimit },
	})
	const error = await assertWithinEntitlement({
		db: atMax.db,
		userId,
		email: null,
		resource: 'concurrent_workflows',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError at the max ceiling.')
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

test('missing-email lookups fail closed and honor free email caps', async () => {
	const { db, counters } = createEntitlementsTestDb()
	const sendLimit = planLimits.free.maxEmailSendsPerDay
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

	const receiveLimit = planLimits.free.maxEmailReceivesPerDay
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
		plan: 'free',
		limit: receiveLimit,
		current: receiveLimit,
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
	expect(underLimit.queries.some(({ sql }) => sql.includes('SUM('))).toBe(false)
	expect(
		underLimit.queries.some(({ sql }) =>
			sql.includes('SET d1_storage_bytes = d1_storage_bytes + ?'),
		),
	).toBe(true)
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

// Asserts the invariant rather than the numbers. `plans.ts` says the limits are
// placeholders meant to be tuned as metering data arrives, so pinning exact
// values here would make every tuning change look like a regression. What must
// never break is the ordering between plans and the persistent-services gate.
test('free plan limits are stricter than pro for every resource', () => {
	for (const resource of entitlementResources) {
		expect(
			resolvePlanLimit('free', resource),
			`free ${resource} should be below pro`,
		).toBeLessThan(resolvePlanLimit('pro', resource))
	}
	// Persistent services are the one hard gate rather than a smaller number:
	// free cannot run them at all.
	expect(planLimits.free.packageServicePersistentAllowed).toBe(0)
	expect(resolvePlanLimit('free', 'persistent_package_services')).toBe(0)
	expect(resolvePlanLimit('pro', 'persistent_package_services')).toBe(1)
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

test('entitlement enforcement stops when a stored plan violates the schema contract', async () => {
	for (const [index, plan] of [
		null,
		'enterprise-2099',
		'unlimited',
	].entries()) {
		const email = `invalid-stored-plan-${index}@example.com`
		const userId = await createStableUserIdFromEmail(email)
		const { db, queries } = createEntitlementsTestDb({
			users: [{ email, plan, stable_user_id: userId }],
			counts: { jobs: planLimits.max.maxScheduledJobs },
		})
		await expect(
			assertWithinEntitlement({
				db,
				userId,
				email,
				resource: 'scheduled_jobs',
			}),
		).rejects.toThrow('Stored plan is not a registered plan name.')
		expect(queries.some((query) => query.sql.includes('FROM jobs'))).toBe(false)
	}
})

test('getUserPlan resolves effective plan from manual plan and stripe_plan', async () => {
	const freePlusProEmail = 'manual-free-stripe-pro@example.com'
	const proPlusPartnerEmail = 'manual-pro-stripe-partner@example.com'
	const unlimitedPlusProEmail = 'manual-unlimited-stripe-pro@example.com'
	const freePlusProUserId = await createStableUserIdFromEmail(freePlusProEmail)
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

test('countRunningPackageServices queries package_service_states with staleness and excludeService', async () => {
	const now = new Date('2026-07-26T12:00:00.000Z')
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql: query, params })
					return {
						async first<T>() {
							return { count: 2 } as T
						},
					}
				},
			}
		},
	} as unknown as D1Database

	expect(
		await countRunningPackageServices({
			db,
			userId: 'user-1',
			now,
		}),
	).toBe(2)
	expect(queries[0]?.sql).toContain('FROM package_service_states')
	expect(queries[0]?.params).toEqual([
		'user-1',
		new Date(now.valueOf() - packageServiceStateStaleMs).toISOString(),
	])

	queries.length = 0
	await countRunningPackageServices({
		db,
		userId: 'user-1',
		now,
		excludeService: { packageId: 'pkg-1', serviceName: 'worker' },
	})
	expect(queries[0]?.sql).toContain(
		'AND NOT (package_id = ? AND service_name = ?)',
	)
	expect(queries[0]?.params).toEqual([
		'user-1',
		new Date(now.valueOf() - packageServiceStateStaleMs).toISOString(),
		'pkg-1',
		'worker',
	])
})
