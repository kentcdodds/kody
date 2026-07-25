import { expect, test } from 'vitest'
import { loadAccountUsageData } from '#app/account-usage-data.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

function createUsageTestDb(input: {
	userId: number
	email: string
	plan: string
	stripePlan?: string | null
	packageCount?: number
}) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	return {
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
							if (normalized.includes('from entitlement_daily_counters')) {
								return { count: 0 } as T
							}
							if (
								normalized.includes('count(*)') ||
								normalized.includes('sum(')
							) {
								return { count: 0, total: 0 } as T
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
	} as unknown as D1Database
}

test('loadAccountUsageData returns plan and entitlement rows for the account', async () => {
	const env = {
		APP_DB: createUsageTestDb({
			userId: 7,
			email: 'usage@example.com',
			plan: 'free',
			packageCount: 2,
		}),
	} as Env

	const data = await loadAccountUsageData({
		env,
		userId: 7,
		now: new Date('2026-07-25T12:00:00.000Z'),
	})
	expect(data?.ok).toBe(true)
	expect(data?.plan).toBe('free')
	expect(data?.today).toBe('2026-07-25')
	const packages = data?.entitlementConsumption.find(
		(row) => row.resource === 'saved_packages',
	)
	expect(packages?.current).toBe(2)
	expect(packages?.limit).toBeGreaterThan(0)
	expect(data?.entitlementConsumption.length).toBeGreaterThan(5)
})
