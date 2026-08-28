import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildUserEmailOutboundPausedIdempotencyKey,
	type UserEmailOutboundPausedEvent,
} from './outbound-paused-subscription-event.ts'

const userEmailOutboundPausedSubscriptionActorTokenId =
	'internal:user-email-outbound-paused-subscriptions'

/**
 * Fans an outbound-mail abuse pause to admin-owned packages that declare
 * `user.email_outbound.paused`. Best-effort: the pause is already committed,
 * and a missed invoke is logged rather than failing delivery-event
 * processing.
 */
export async function dispatchUserEmailOutboundPausedSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: UserEmailOutboundPausedEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'user-email-outbound-paused',
		buildIdempotencyKey: (savedPackage) =>
			buildUserEmailOutboundPausedIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: userEmailOutboundPausedSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
