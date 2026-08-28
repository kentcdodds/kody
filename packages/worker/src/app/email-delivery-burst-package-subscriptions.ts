import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildEmailDeliveryBurstIdempotencyKey,
	type EmailDeliveryBurstEvent,
} from './email-delivery-burst-subscription-event.ts'

const emailDeliveryBurstSubscriptionActorTokenId =
	'internal:email-delivery-burst-subscriptions'

/**
 * Fans a shared-domain bounce/complaint burst to admin-owned packages that
 * declare `email.delivery.burst`. Best-effort: alert rows already exist,
 * and a missed invoke is logged rather than failing the hourly cron.
 */
export async function dispatchEmailDeliveryBurstSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: EmailDeliveryBurstEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'email-delivery-burst',
		buildIdempotencyKey: (savedPackage) =>
			buildEmailDeliveryBurstIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: emailDeliveryBurstSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
