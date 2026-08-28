import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildUserEmailVerificationFailedIdempotencyKey,
	type UserEmailVerificationFailedEvent,
} from './email-verification-failed-subscription-event.ts'

const userEmailVerificationFailedSubscriptionActorTokenId =
	'internal:user-email-verification-failed-subscriptions'

/**
 * Fans a verification-mail terminal failure to admin-owned packages that
 * declare `user.email_verification.failed`. Best-effort: the user row
 * already carries the bounce, and a missed invoke is logged rather than
 * failing delivery-event processing.
 */
export async function dispatchUserEmailVerificationFailedSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: UserEmailVerificationFailedEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'user-email-verification-failed',
		buildIdempotencyKey: (savedPackage) =>
			buildUserEmailVerificationFailedIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: userEmailVerificationFailedSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
