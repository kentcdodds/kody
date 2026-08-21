import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildUserLifecycleIdempotencyKey,
	type UserLifecycleEvent,
} from './user-lifecycle-subscription-event.ts'

const userLifecycleSubscriptionActorTokenId =
	'internal:user-lifecycle-subscriptions'

/**
 * Fans a user create or delete snapshot to admin-owned packages that declare
 * `user.created` or `user.deleted`. Best-effort: the account row change is
 * already committed, and a missed invoke is logged rather than failing signup
 * or deletion.
 */
export async function dispatchUserLifecycleSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: UserLifecycleEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'user-lifecycle',
		buildIdempotencyKey: (savedPackage) =>
			buildUserLifecycleIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: userLifecycleSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
