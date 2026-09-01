import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildUserEmailVerificationStalledIdempotencyKey,
	type UserEmailVerificationStalledEvent,
} from './email-verification-stalled-subscription-event.ts'

const userEmailVerificationStalledSubscriptionActorTokenId =
	'internal:user-email-verification-stalled-subscriptions'

/**
 * Fans a stalled signup/verify send (accepted, no Cloudflare lifecycle
 * event) to admin-owned packages that declare
 * `user.email_verification.stalled`. Best-effort: the user row already
 * carries `accepted`, and a missed invoke is logged rather than failing
 * the hourly scan.
 */
export async function dispatchUserEmailVerificationStalledSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: UserEmailVerificationStalledEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'user-email-verification-stalled',
		buildIdempotencyKey: (savedPackage) =>
			buildUserEmailVerificationStalledIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: userEmailVerificationStalledSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
