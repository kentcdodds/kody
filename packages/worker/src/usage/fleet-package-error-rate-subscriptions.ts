import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildFleetPackageErrorRateIdempotencyKey,
	type FleetPackageErrorRateElevatedEvent,
} from './fleet-package-error-rate-subscription-event.ts'

const fleetPackageErrorRateSubscriptionActorTokenId =
	'internal:fleet-package-error-rate-subscriptions'

/**
 * Fans a content-free fleet package error-rate elevation to admin-owned
 * packages that declare `fleet.package_error_rate.elevated`. Best-effort: the
 * KV snapshot is already written, and a missed invoke is logged rather than
 * failing usage aggregation.
 */
export async function dispatchFleetPackageErrorRateSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: FleetPackageErrorRateElevatedEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'fleet-package-error-rate',
		buildIdempotencyKey: (savedPackage) =>
			buildFleetPackageErrorRateIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: fleetPackageErrorRateSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
