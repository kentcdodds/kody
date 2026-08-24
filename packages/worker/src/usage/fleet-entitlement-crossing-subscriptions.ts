import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildFleetEntitlementCrossingIdempotencyKey,
	type FleetEntitlementCrossedEvent,
} from './fleet-entitlement-crossing-subscription-event.ts'

const fleetEntitlementCrossingSubscriptionActorTokenId =
	'internal:fleet-entitlement-crossing-subscriptions'

/**
 * Fans one fleet entitlement crossing to admin-owned packages that declare
 * `fleet.entitlement.crossed`. Best-effort: a missed invoke is logged rather
 * than failing the hourly usage-entitlement sweep.
 */
export async function dispatchFleetEntitlementCrossingSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: FleetEntitlementCrossedEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'fleet-entitlement-crossing',
		buildIdempotencyKey: (savedPackage) =>
			buildFleetEntitlementCrossingIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: fleetEntitlementCrossingSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
