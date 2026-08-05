import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { accountUsageEntitlementResources } from '#worker/entitlements/resource-visibility.ts'

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
	repoCount?: number
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
								if (normalized.includes('from user_repos')) {
									return { count: input.repoCount ?? 0 } as T
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

test('readEntitlementUsageSnapshot marks rows above 80% as warnings', async () => {
	const now = new Date('2026-07-25T12:00:00.000Z')
	const day = utcDayKey(now)
	const email = 'warn@example.com'
	const { stableUserId, db } = createUsageTestDb({
		email,
		packageCount: 9,
	})
	const env = withUsageEnv({ APP_DB: db })
	await env.meter.seed({
		userId: stableUserId,
		resource: 'email_sends_per_day',
		day,
		count: 9,
	})
	const snapshot = await readEntitlementUsageSnapshot({
		db,
		env: env as Env,
		usageUserId: stableUserId,
		plan: 'free',
		now,
	})
	const sends = snapshot.resources.find(
		(row) => row.resource === 'email_sends_per_day',
	)
	expect(sends?.overEightyPercent).toBe(true)
	expect(
		snapshot.warnings.some((row) => row.resource === 'email_sends_per_day'),
	).toBe(true)
	const packages = snapshot.resources.find(
		(row) => row.resource === 'saved_packages',
	)
	expect(packages?.overEightyPercent).toBe(false)
})

test('readEntitlementUsageSnapshot includes all registered usage resources', async () => {
	const email = 'all@example.com'
	const { stableUserId, db } = createUsageTestDb({ email, repoCount: 1 })
	const env = withUsageEnv({ APP_DB: db })
	const snapshot = await readEntitlementUsageSnapshot({
		db,
		env: env as Env,
		usageUserId: stableUserId,
		plan: 'pro',
	})
	expect(snapshot.resources.map((row) => row.resource)).toEqual(
		accountUsageEntitlementResources,
	)
})
