import { expect, test, vi } from 'vitest'

const readCurrentEntitlementResourceUsage = vi.fn()

vi.mock('#worker/entitlements/service.ts', () => ({
	readCurrentEntitlementResourceUsage: (...args: Array<unknown>) =>
		readCurrentEntitlementResourceUsage(...args),
}))

const { readAdminEntitlementConsumption } =
	await import('#worker/admin/entitlement-consumption.ts')

test('readAdminEntitlementConsumption scores legacy Standard against legacyPlanLimits', async () => {
	const outboundCurrent = 15_016
	readCurrentEntitlementResourceUsage.mockImplementation(async (input) => {
		return input.resource === 'outbound_fetches_per_day' ? outboundCurrent : 0
	})
	const env = { APP_DB: {} } as Env
	const now = new Date('2026-07-08T12:00:00.000Z')
	const [publicConsumption, legacyConsumption] = await Promise.all([
		readAdminEntitlementConsumption({
			env,
			usageUserId: 'grant',
			plan: 'standard',
			ladder: 'public',
			now,
		}),
		readAdminEntitlementConsumption({
			env,
			usageUserId: 'grant',
			plan: 'standard',
			ladder: 'legacy',
			now,
		}),
	])
	const publicOutbound = publicConsumption.find(
		(item) => item.resource === 'outbound_fetches_per_day',
	)
	const legacyOutbound = legacyConsumption.find(
		(item) => item.resource === 'outbound_fetches_per_day',
	)
	expect(publicOutbound?.current).toBe(outboundCurrent)
	expect(legacyOutbound?.current).toBe(outboundCurrent)
	expect(publicOutbound?.overEightyPercent).toBe(true)
	expect(legacyOutbound?.overEightyPercent).toBe(false)
	expect(legacyOutbound?.limit ?? 0).toBeGreaterThan(publicOutbound?.limit ?? 0)
})
