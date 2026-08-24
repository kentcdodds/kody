import { expect, test, vi } from 'vitest'
import {
	buildFleetEntitlementCrossingIdempotencyKey,
	buildFleetEntitlementResourceCrossedEvent,
	fleetEntitlementCrossedTopic,
} from './fleet-entitlement-crossing-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchFleetEntitlementCrossingSubscriptionEvent } =
	await import('./fleet-entitlement-crossing-subscriptions.ts')

test('fleet entitlement crossing dispatch fans metadata-only events through admin package fan-out', async () => {
	const event = buildFleetEntitlementResourceCrossedEvent({
		user: { id: 'user-1', username: 'maciek' },
		resource: 'saved_packages',
		label: 'saved packages',
		threshold: 'reached',
		current: 10,
		limit: 10,
		percentOfLimit: 1,
		insightsUrl: 'https://kody.codes/admin/insights',
		usersUrl: 'https://kody.codes/admin/users',
		observedAt: '2026-08-24T16:00:18.000Z',
	})

	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: {
			getParams: () =>
				| Record<string, unknown>
				| Promise<Record<string, unknown>>
			buildIdempotencyKey: (savedPackage: { id: string }) => string
			[key: string]: unknown
		}) => [
			{
				params: await input.getParams(),
				idempotencyKey: input.buildIdempotencyKey({ id: 'package-1' }),
				input,
			},
		],
	)

	const result = await dispatchFleetEntitlementCrossingSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://kody.codes',
		},
		event,
	})

	expect(result[0]).toMatchObject({
		params: event,
		idempotencyKey: buildFleetEntitlementCrossingIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: fleetEntitlementCrossedTopic,
			source: 'fleet-entitlement-crossing',
			actorTokenId: 'internal:fleet-entitlement-crossing-subscriptions',
		},
	})
	expect(JSON.stringify(result[0]?.params)).not.toContain('email')
	expect(JSON.stringify(result[0]?.params)).not.toContain('plan')
})
