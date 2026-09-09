import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { usageGetCapability } from './usage-get.ts'

function withUsageEnv(env: { APP_DB: D1Database } & Record<string, unknown>) {
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	const repoSessionIndex = createInMemoryRepoSessionIndexEnv(env.APP_DB)
	return {
		...env,
		...meter.env,
		...runLog.env,
		REPO_SESSION_INDEX: repoSessionIndex.REPO_SESSION_INDEX,
		MAILBOX: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ countMessages: async () => ({ total: 0 }) }),
		},
		meter,
		runLog,
	}
}

function createUsageTestDb(input: {
	email: string
	plan: string
	stripePlan?: string | null
	entitlementLadder?: 'public' | 'legacy'
	stripeCustomerId?: string | null
	packageCount?: number
	uniqueWorkerDays?: number
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
								if (normalized.includes('stripe_customer_id')) {
									return {
										id: 1,
										stripe_customer_id: input.stripeCustomerId ?? null,
									} as T
								}
								if (
									normalized.includes('from users') &&
									normalized.includes('email')
								) {
									return {
										plan: input.plan,
										stripe_plan: input.stripePlan ?? null,
										entitlement_ladder: input.entitlementLadder ?? 'public',
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

test('usageGet returns self-scoped entitlement snapshot', async () => {
	const email = 'usage-get@example.com'
	const userId = testStableUserIdFromEmail(email)
	const { db } = createUsageTestDb({
		email,
		plan: 'pro',
		packageCount: 1,
	})
	const meterEnv = withUsageEnv({ APP_DB: db })
	const env = meterEnv as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: { userId, email, displayName: 'Usage' },
	})

	await expect(
		usageGetCapability.handler(
			{},
			{
				env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)

	const result = await usageGetCapability.handler({}, { env, callerContext })
	expect(result.plan).toBe('pro')
	const uniqueWorkerDays = result.resources.find(
		(row) => row.resource === 'unique_worker_days',
	)
	expect(uniqueWorkerDays?.label).toBe('Unique worker days')
	expect(uniqueWorkerDays?.group).toBe('monthly')
	expect(uniqueWorkerDays?.current).toBe(0)
	expect(uniqueWorkerDays?.limit).toBe(2_000)
	expect(uniqueWorkerDays?.overEightyPercent).toBe(false)
	const saved = result.resources.find(
		(row) => row.resource === 'saved_packages',
	)
	expect(saved?.current).toBe(1)
	expect(saved?.limit).toBeGreaterThan(0)
	const execute = result.resources.find(
		(row) => row.resource === 'execute_calls_per_day',
	)
	expect(execute?.limit).toBe(1_500)
	expect(execute?.week).toEqual({
		current: 0,
		limit: 4_000,
		percent: 0,
		overEightyPercent: false,
	})
	expect(result.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('usageGet reports legacy Standard ceilings for grandfathered accounts', async () => {
	const email = 'legacy-usage-get@example.com'
	const userId = testStableUserIdFromEmail(email)
	const { db } = createUsageTestDb({
		email,
		plan: 'free',
		stripePlan: 'standard',
		entitlementLadder: 'legacy',
	})
	const env = withUsageEnv({ APP_DB: db }) as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: { userId, email, displayName: 'Legacy' },
	})

	const result = await usageGetCapability.handler({}, { env, callerContext })
	expect(result.plan).toBe('standard')
	const execute = result.resources.find(
		(row) => row.resource === 'execute_calls_per_day',
	)
	expect(execute?.limit).toBe(500)
	expect(execute?.week).toBeUndefined()
	expect(result.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('usageGet warns on unique worker days with whatCounts and howToReduce', async () => {
	const email = 'uwd-usage-get@example.com'
	const userId = testStableUserIdFromEmail(email)
	const { db } = createUsageTestDb({
		email,
		plan: 'free',
		uniqueWorkerDays: 50,
	})
	const env = withUsageEnv({ APP_DB: db }) as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: { userId, email, displayName: 'Uwd' },
	})

	const result = await usageGetCapability.handler({}, { env, callerContext })
	const uniqueWorkerDays = result.resources.find(
		(row) => row.resource === 'unique_worker_days',
	)
	expect(uniqueWorkerDays?.current).toBe(50)
	expect(uniqueWorkerDays?.limit).toBe(50)
	expect(uniqueWorkerDays?.percent).toBe(1)
	expect(uniqueWorkerDays?.overEightyPercent).toBe(true)
	expect(
		result.warnings.some((row) => row.resource === 'unique_worker_days'),
	).toBe(true)
})
