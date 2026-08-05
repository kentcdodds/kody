import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { accountUsageEntitlementResources } from '#worker/entitlements/resource-visibility.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { usageGetCapability } from './usage-get.ts'

function withUsageEnv(env: { APP_DB: D1Database } & Record<string, unknown>) {
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	return {
		...env,
		...meter.env,
		...runLog.env,
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
									normalized.includes('email')
								) {
									return {
										plan: input.plan,
										stripe_plan: input.stripePlan ?? null,
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

test('usage_get returns self-scoped entitlement snapshot', async () => {
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
	expect(result.resources.length).toBe(accountUsageEntitlementResources.length)
	const saved = result.resources.find(
		(row) => row.resource === 'saved_packages',
	)
	expect(saved?.current).toBe(1)
	expect(saved?.limit).toBeGreaterThan(0)
	expect(saved?.percent).toBe(saved!.current / saved!.limit)
	expect(saved?.whatCounts).toMatch(/saved packages/i)
})
