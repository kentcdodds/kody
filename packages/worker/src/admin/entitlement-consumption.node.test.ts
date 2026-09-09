import { expect, test, vi } from 'vitest'
import {
	entitlementResourceLabels,
	legacyPlanLimits,
	planLimits,
} from '#universal/plans.ts'

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
	expect(publicOutbound).toEqual({
		resource: 'outbound_fetches_per_day',
		label: entitlementResourceLabels.outbound_fetches_per_day,
		current: outboundCurrent,
		limit: planLimits.standard.maxOutboundFetchesPerDay,
		percentOfLimit:
			outboundCurrent / planLimits.standard.maxOutboundFetchesPerDay,
		overEightyPercent: true,
	})
	expect(legacyOutbound).toEqual({
		resource: 'outbound_fetches_per_day',
		label: entitlementResourceLabels.outbound_fetches_per_day,
		current: outboundCurrent,
		limit: legacyPlanLimits.standard.maxOutboundFetchesPerDay,
		percentOfLimit:
			outboundCurrent / legacyPlanLimits.standard.maxOutboundFetchesPerDay,
		overEightyPercent: false,
	})
})
