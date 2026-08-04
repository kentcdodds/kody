import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	EntitlementLimitError,
	buildEntitlementLimitMessage,
	buildEntitlementUpgradeHint,
	parseEntitlementLimitMessage,
} from './errors.ts'
import { planLimits, resolvePlanLimit } from './plans.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	estimateEntitlementStorageEntryByteDelta,
	estimateEntitlementStorageEntryBytes,
	findCachedUserAccountByStableUserId,
	getCachedUserPlan,
	getUserPlan,
	readCurrentEntitlementResourceUsage,
	refundDailyEntitlement,
} from './service.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	createInMemoryUserMeterEnv,
	createWaitUntilDrain,
} from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from './user-meter-client.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

function createEntitlementsTestDb(
	input: {
		users?: Array<{
			email: string
			plan: string | null
			stripe_plan?: string | null
			stable_user_id: string
			d1_storage_bytes?: number
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
				| 'email_attachments',
				number
			>
		>
	} = {},
) {
	const users = input.users ?? []
	const counts = input.counts ?? {}
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	// Track D1 mirror bytes per user (for MAX mirror assertions)
	const d1StorageByUser = new Map(
		users.map((user) => [user.stable_user_id, user.d1_storage_bytes ?? 0]),
	)
	// Track mirror calls for test assertions
	const mirrorCalls: Array<{ userId: string; bytes: number }> = []

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
								const userId = String(params[0])
								const bytes = d1StorageByUser.get(userId)
								return (bytes === undefined ? null : { bytes }) as T | null
							}
							const count = countFor(query)
							if (count !== null) {
								return { count } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							// D1 mirror update: SET d1_storage_bytes = MAX(d1_storage_bytes, ?)
							if (query.includes('SET d1_storage_bytes = MAX(')) {
								const bytes = Number(params[0])
								const userId = String(params[2])
								const existing = d1StorageByUser.get(userId)
								if (existing !== undefined) {
									d1StorageByUser.set(userId, Math.max(existing, bytes))
									mirrorCalls.push({ userId, bytes })
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

	return { db, queries, d1StorageByUser, mirrorCalls }
}

async function readMeterDailyCount(input: {
	env: ReturnType<typeof createInMemoryUserMeterEnv>['env']
	userId: string
	resource:
		| 'email_sends_per_day'
		| 'email_receives_per_day'
		| 'execute_calls_per_day'
		| 'outbound_fetches_per_day'
	now: Date
}) {
	const result = await userMeterRpc({
		env: input.env,
		userId: input.userId,
	}).read({
		resource: input.resource,
		day: utcDayKey(input.now),
		now: input.now.toISOString(),
	})
	return result.outcome === 'ready' ? result.count : 0
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

test('assertWithinEntitlement enforces concurrent workflow limits without email and reverse-resolves blank emails', async () => {
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	const { db } = createEntitlementsTestDb()
	// concurrent_workflows occupancy is RunLog-backed; create path passes
	// getCurrent from reserveWorkflowProjectionSlot.
	const freeDenial = await assertWithinEntitlement({
		db,
		userId: 'user-1',
		email: null,
		resource: 'concurrent_workflows',
		getCurrent: async () => freeLimit,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(freeDenial instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(freeDenial.details).toMatchObject({
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})

	const userId = await createStableUserIdFromEmail(plannedEmail)
	const maxLimit = planLimits.max.maxConcurrentWorkflows
	const underMax = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
	})
	await assertWithinEntitlement({
		db: underMax.db,
		userId,
		email: '',
		resource: 'concurrent_workflows',
		getCurrent: async () => freeLimit,
	})

	const atMax = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
	})
	const maxDenial = await assertWithinEntitlement({
		db: atMax.db,
		userId,
		email: null,
		resource: 'concurrent_workflows',
		getCurrent: async () => maxLimit,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(maxDenial instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError at the max ceiling.')
	}
	expect(maxDenial.details).toMatchObject({
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
	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'free', stable_user_id: userId }],
	})
	const { env } = createInMemoryUserMeterEnv()
	expect(utcDayKey(now)).toBe('2026-07-05')

	const limit = planLimits.free.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric email send limit.')
	for (let index = 0; index < limit; index += 1) {
		await consumeDailyEntitlement({
			db,
			env,
			userId,
			email: plannedEmail,
			resource: 'email_sends_per_day',
			now,
		})
	}
	expect(
		await readMeterDailyCount({
			env,
			userId,
			resource: 'email_sends_per_day',
			now,
		}),
	).toBe(limit)
	await expect(
		assertWithinEntitlement({
			db,
			userId,
			email: plannedEmail,
			resource: 'email_sends_per_day',
			now,
		}),
	).rejects.toThrow(/must be read from UserMeter/)

	const denied = await consumeDailyEntitlement({
		db,
		env,
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

	const nextDay = new Date('2026-07-06T00:00:01.000Z')
	await consumeDailyEntitlement({
		db,
		env,
		userId,
		email: plannedEmail,
		resource: 'email_sends_per_day',
		now: nextDay,
	})
	expect(
		await readMeterDailyCount({
			env,
			userId,
			resource: 'email_sends_per_day',
			now: nextDay,
		}),
	).toBe(1)
	expect(
		await readMeterDailyCount({
			env,
			userId,
			resource: 'email_sends_per_day',
			now,
		}),
	).toBe(limit)
})

test('refundDailyEntitlement decrements the user/day counter and floors at zero', async () => {
	const { db } = createEntitlementsTestDb()
	const { env } = createInMemoryUserMeterEnv()
	const now = new Date('2026-07-05T15:00:00.000Z')
	for (let index = 0; index < 2; index += 1) {
		await consumeDailyEntitlement({
			db,
			env,
			userId: 'user-1',
			email: null,
			resource: 'email_receives_per_day',
			now,
		})
	}
	for (let index = 0; index < 3; index += 1) {
		await consumeDailyEntitlement({
			db,
			env,
			userId: 'user-2',
			email: null,
			resource: 'email_receives_per_day',
			now,
		})
	}
	await refundDailyEntitlement({
		db,
		env,
		userId: 'user-1',
		resource: 'email_receives_per_day',
		now,
	})
	expect(
		await readMeterDailyCount({
			env,
			userId: 'user-1',
			resource: 'email_receives_per_day',
			now,
		}),
	).toBe(1)
	expect(
		await readMeterDailyCount({
			env,
			userId: 'user-2',
			resource: 'email_receives_per_day',
			now,
		}),
	).toBe(3)

	await refundDailyEntitlement({
		db,
		env,
		userId: 'user-1',
		resource: 'email_receives_per_day',
		now,
	})
	await refundDailyEntitlement({
		db,
		env,
		userId: 'user-1',
		resource: 'email_receives_per_day',
		now,
	})
	expect(
		await readMeterDailyCount({
			env,
			userId: 'user-1',
			resource: 'email_receives_per_day',
			now,
		}),
	).toBe(0)
})

test('missing-email lookups fail closed and honor free email caps', async () => {
	const { db } = createEntitlementsTestDb()
	const { env } = createInMemoryUserMeterEnv()
	const sendLimit = planLimits.free.maxEmailSendsPerDay
	const now = new Date('2026-07-05T15:00:00.000Z')
	for (let index = 0; index < sendLimit; index += 1) {
		await consumeDailyEntitlement({
			db,
			env,
			userId: 'user-1',
			email: null,
			resource: 'email_sends_per_day',
			now,
		})
	}
	expect(
		await readMeterDailyCount({
			env,
			userId: 'user-1',
			resource: 'email_sends_per_day',
			now,
		}),
	).toBe(sendLimit)
	await expect(
		consumeDailyEntitlement({
			db,
			env,
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
			env,
			userId: 'user-1',
			email: null,
			resource: 'email_receives_per_day',
			now,
		})
	}
	expect(
		await readMeterDailyCount({
			env,
			userId: 'user-1',
			resource: 'email_receives_per_day',
			now,
		}),
	).toBe(receiveLimit)

	const denied = await consumeDailyEntitlement({
		db,
		env,
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

	// Max plan: already at limit, reserve of 1 should be denied.
	const { env: maxEnv } = createInMemoryUserMeterEnv()
	await maxEnv.USER_METER.get(
		maxEnv.USER_METER.idFromName(userId),
	).initializeStorageBytes({
		bytes: maxLimit,
		updatedAt: new Date().toISOString(),
	})
	const maxAt = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'max', stable_user_id: userId }],
	})
	const maxDenied = await assertWithinStorageBytesEntitlement({
		db: maxAt.db,
		userId,
		email: plannedEmail,
		requested: 1,
		env: maxEnv,
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

	// Pro plan: at limit.
	const { env: proEnv } = createInMemoryUserMeterEnv()
	await proEnv.USER_METER.get(
		proEnv.USER_METER.idFromName(userId),
	).initializeStorageBytes({
		bytes: proLimit,
		updatedAt: new Date().toISOString(),
	})
	const atLimit = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
	})
	const denied = await assertWithinStorageBytesEntitlement({
		db: atLimit.db,
		userId,
		email: plannedEmail,
		requested: 1,
		env: proEnv,
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

	// Under limit: reserve succeeds and schedules D1 mirror.
	const { env: underEnv } = createInMemoryUserMeterEnv()
	await underEnv.USER_METER.get(
		underEnv.USER_METER.idFromName(userId),
	).initializeStorageBytes({
		bytes: proLimit - 1,
		updatedAt: new Date().toISOString(),
	})
	const drain = createWaitUntilDrain()
	const underLimit = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
				d1_storage_bytes: proLimit - 1,
			},
		],
	})
	await assertWithinStorageBytesEntitlement({
		db: underLimit.db,
		userId,
		email: plannedEmail,
		requested: 1,
		env: underEnv,
		waitUntil: drain.waitUntil.bind(drain),
	})
	await drain.drain()
	// D1 mirror should have been called and advanced to proLimit.
	expect(underLimit.mirrorCalls.length).toBeGreaterThan(0)
	expect(underLimit.mirrorCalls.at(-1)?.bytes).toBe(proLimit)
	// Does not do a payload table SUM scan (no getCurrent path).
	expect(underLimit.queries.some(({ sql }) => sql.includes('SUM('))).toBe(false)
})

test('storage byte reserve bootstraps from D1 on cold UserMeter, then retries', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const proLimit = planLimits.pro.maxStorageBytes
	const { env } = createInMemoryUserMeterEnv()
	// UserMeter has no storage bytes row yet (needs_bootstrap).
	const drain = createWaitUntilDrain()
	const coldDb = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
				d1_storage_bytes: proLimit - 10,
			},
		],
	})

	await assertWithinStorageBytesEntitlement({
		db: coldDb.db,
		userId,
		email: plannedEmail,
		requested: 5,
		env,
		waitUntil: drain.waitUntil.bind(drain),
	})
	await drain.drain()

	// UserMeter should now be seeded with proLimit - 10 + 5 = proLimit - 5.
	const meter = userMeterRpc({ env, userId })
	const result = await meter.readStorageBytes()
	expect(result).toMatchObject({ outcome: 'ready', bytes: proLimit - 5 })
	// D1 mirror should have been called with the DO absolute.
	expect(coldDb.mirrorCalls.length).toBeGreaterThan(0)
	expect(coldDb.mirrorCalls.at(-1)?.bytes).toBe(proLimit - 5)
})

test('storage byte reserve fails at limit after cold bootstrap', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const proLimit = planLimits.pro.maxStorageBytes
	const { env } = createInMemoryUserMeterEnv()
	// D1 mirror at limit — cold bootstrap will seed DO at limit, then reserve fails.
	const db = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
				d1_storage_bytes: proLimit,
			},
		],
	})
	const denied = await assertWithinStorageBytesEntitlement({
		db: db.db,
		userId,
		email: plannedEmail,
		requested: 1,
		env,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError after cold bootstrap.')
	}
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		plan: 'pro',
		limit: proLimit,
		current: proLimit,
	})
})

test('storage byte reserve handles missing user (synthetic context) with free-plan semantics', async () => {
	// A userId with no D1 row: synthetic context (e.g. test fixture, non-account).
	// env.USER_METER is present but the user has no D1 row, so the function must
	// apply free-plan allow/deny without attempting to create a DO entry.
	const syntheticUserId = 'a'.repeat(64)
	const { env } = createInMemoryUserMeterEnv()
	const freeLimit = planLimits.free.maxStorageBytes

	// No users row in D1 — readUserD1StorageBytesRow returns null.
	const emptyDb = createEntitlementsTestDb({ users: [] })

	// Under free limit: should pass without touching DO.
	await assertWithinStorageBytesEntitlement({
		db: emptyDb.db,
		userId: syntheticUserId,
		email: null,
		requested: 1,
		env,
	})
	// No storage bytes row should be created in DO for a non-existent account.
	const meter = userMeterRpc({ env, userId: syntheticUserId })
	expect(await meter.readStorageBytes()).toEqual({ outcome: 'needs_bootstrap' })

	// At free limit: should be denied.
	const { env: env2 } = createInMemoryUserMeterEnv()
	const emptyDb2 = createEntitlementsTestDb({ users: [] })
	const denied = await assertWithinStorageBytesEntitlement({
		db: emptyDb2.db,
		userId: syntheticUserId,
		email: null,
		requested: freeLimit + 1,
		env: env2,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error(
			'Expected EntitlementLimitError for synthetic over-limit context.',
		)
	}
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		plan: 'free',
	})
})

test('storage byte reserve: D1 mirror failure is silent and does not affect success', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const proLimit = planLimits.pro.maxStorageBytes
	const { env } = createInMemoryUserMeterEnv()
	await env.USER_METER.get(
		env.USER_METER.idFromName(userId),
	).initializeStorageBytes({
		bytes: proLimit - 10,
		updatedAt: new Date().toISOString(),
	})

	const failingMirrorDb = {
		prepare(query: string) {
			return {
				bind(..._params: Array<unknown>) {
					return {
						async first<T>() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								return { plan: 'pro', stripe_plan: null } as T
							}
							if (query.includes('SELECT d1_storage_bytes AS bytes')) {
								return { bytes: proLimit - 10 } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							if (query.includes('SET d1_storage_bytes = MAX(')) {
								throw new Error('D1 mirror write failed')
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const drain = createWaitUntilDrain()
	// Reserve must succeed even when the D1 mirror write throws.
	await assertWithinStorageBytesEntitlement({
		db: failingMirrorDb,
		userId,
		email: plannedEmail,
		requested: 5,
		env,
		waitUntil: drain.waitUntil.bind(drain),
	})
	// Drain the mirror task; it should fail silently.
	consoleWarn.mockImplementation(() => {})
	await drain.drain()

	// UserMeter should have the reservation applied.
	const meter = userMeterRpc({ env, userId })
	const result = await meter.readStorageBytes()
	expect(result).toMatchObject({ outcome: 'ready', bytes: proLimit - 5 })
})

test('storage byte D1 mirror uses MAX to prevent delayed mirrors from regressing D1', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { env } = createInMemoryUserMeterEnv()
	await env.USER_METER.get(
		env.USER_METER.idFromName(userId),
	).initializeStorageBytes({
		bytes: 1000,
		updatedAt: new Date().toISOString(),
	})
	const drain = createWaitUntilDrain()
	const testDb = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
				d1_storage_bytes: 2000,
			},
		],
	})

	// Reserve 100 bytes (DO at 1000, result will be 1100).
	await assertWithinStorageBytesEntitlement({
		db: testDb.db,
		userId,
		email: plannedEmail,
		requested: 100,
		env,
		waitUntil: drain.waitUntil.bind(drain),
	})
	await drain.drain()

	// D1 mirror had 2000; the mirror call was for 1100.
	// MAX(2000, 1100) = 2000 — D1 should not have regressed.
	const mirrorCall = testDb.mirrorCalls.at(-1)
	expect(mirrorCall?.bytes).toBe(1100)
	// d1StorageByUser should remain at 2000 due to MAX semantics.
	expect(testDb.d1StorageByUser.get(userId)).toBe(2000)
})

test('storage byte reserve without env throws immediately on DO-reserve path', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { db } = createEntitlementsTestDb({
		users: [{ email: plannedEmail, plan: 'pro', stable_user_id: userId }],
	})
	await expect(
		assertWithinStorageBytesEntitlement({
			db,
			userId,
			email: plannedEmail,
			requested: 1,
			// env intentionally omitted
		}),
	).rejects.toThrow(
		'assertWithinStorageBytesEntitlement requires env.USER_METER',
	)
})

test('storage byte reserve concurrent bootstraps converge: second needs_bootstrap after initialize succeeds', async () => {
	// Both callers see needs_bootstrap; the first initializes, the second retries
	// and succeeds (initializeStorageBytes is INSERT OR IGNORE — idempotent).
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const proLimit = planLimits.pro.maxStorageBytes
	const { env } = createInMemoryUserMeterEnv()
	const db = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
				d1_storage_bytes: proLimit - 20,
			},
		],
	})

	// Fire two concurrent reserves, both starting before any DO row exists.
	await Promise.all([
		assertWithinStorageBytesEntitlement({
			db: db.db,
			userId,
			email: plannedEmail,
			requested: 5,
			env,
		}),
		assertWithinStorageBytesEntitlement({
			db: db.db,
			userId,
			email: plannedEmail,
			requested: 5,
			env,
		}),
	])
	// Both reservations succeeded: UserMeter should have proLimit - 10.
	const result = await userMeterRpc({ env, userId }).readStorageBytes()
	expect(result).toMatchObject({ outcome: 'ready', bytes: proLimit - 10 })
})

test('readCurrentEntitlementResourceUsage for storage_bytes reads from UserMeter with cold bootstrap', async () => {
	const userId = await createStableUserIdFromEmail(plannedEmail)
	const { env } = createInMemoryUserMeterEnv()
	const now = new Date()

	// Cold: no DO row. DB has d1_storage_bytes = 500.
	const coldDb = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
				d1_storage_bytes: 500,
			},
		],
	})
	const coldBytes = await readCurrentEntitlementResourceUsage({
		db: coldDb.db,
		env,
		userId,
		resource: 'storage_bytes',
		now,
	})
	expect(coldBytes).toBe(500)

	// Warm: DO already has 750.
	await env.USER_METER.get(env.USER_METER.idFromName(userId)).setStorageBytes({
		bytes: 750,
		updatedAt: now.toISOString(),
	})
	const warmDb = createEntitlementsTestDb({
		users: [
			{
				email: plannedEmail,
				plan: 'pro',
				stable_user_id: userId,
				d1_storage_bytes: 500,
			},
		],
	})
	const warmBytes = await readCurrentEntitlementResourceUsage({
		db: warmDb.db,
		env,
		userId,
		resource: 'storage_bytes',
		now,
	})
	expect(warmBytes).toBe(750)
})

test('storage usage reads do not materialize UserMeter state for missing users', async () => {
	const userId = await createStableUserIdFromEmail('missing@example.com')
	const { env } = createInMemoryUserMeterEnv()
	const db = createEntitlementsTestDb({ users: [] })

	await expect(
		readCurrentEntitlementResourceUsage({
			db: db.db,
			env,
			userId,
			resource: 'storage_bytes',
			now: new Date(),
		}),
	).resolves.toBe(0)

	await expect(
		userMeterRpc({ env, userId }).readStorageBytes(),
	).resolves.toEqual({ outcome: 'needs_bootstrap' })
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
