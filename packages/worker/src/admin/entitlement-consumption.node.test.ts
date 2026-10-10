import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as EntitlementsService from '#worker/entitlements/service.ts'

const readCurrentEntitlementResourceUsage =
	vi.fn<typeof EntitlementsService.readCurrentEntitlementResourceUsage>()

vi.mock('#worker/entitlements/service.ts', () => ({
	readCurrentEntitlementResourceUsage: (
		...args: Parameters<
			typeof EntitlementsService.readCurrentEntitlementResourceUsage
		>
	) => readCurrentEntitlementResourceUsage(...args),
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
			usageUserId: ownerIdFromStored('grant'),
			plan: 'standard',
			ladder: 'public',
			creditWallet: 'none',
			now,
		}),
		readAdminEntitlementConsumption({
			env,
			usageUserId: ownerIdFromStored('grant'),
			plan: 'standard',
			ladder: 'legacy',
			creditWallet: 'none',
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

test('readAdminEntitlementConsumption scores inbound receives against an optional base plan', async () => {
	readCurrentEntitlementResourceUsage.mockImplementation(async (input) => {
		return input.resource === 'email_receives_per_day' ? 10 : 0
	})
	const env = { APP_DB: {} } as Env
	const now = new Date('2026-07-08T12:00:00.000Z')
	const consumption = await readAdminEntitlementConsumption({
		env,
		usageUserId: ownerIdFromStored('gifted'),
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
		now,
		inboundReceive: {
			plan: 'free',
			ladder: 'public',
			creditWallet: 'none',
		},
	})
	const receives = consumption.find(
		(item) => item.resource === 'email_receives_per_day',
	)
	const packages = consumption.find(
		(item) => item.resource === 'saved_packages',
	)
	expect(receives).toMatchObject({
		current: 10,
		limit: 10,
		overEightyPercent: true,
	})
	expect(packages?.limit).toBe(200)
})
