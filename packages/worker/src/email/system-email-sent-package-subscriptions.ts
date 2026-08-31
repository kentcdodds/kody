import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildSystemEmailSentIdempotencyKey,
	type SystemEmailSentEvent,
} from './system-email-sent-subscription-event.ts'

const systemEmailSentSubscriptionActorTokenId =
	'internal:system-email-sent-subscriptions'

/**
 * Fans a successful `sendSystemEmail` to admin-owned packages that declare
 * `email.system-message.sent`. Best-effort: the provider send already
 * succeeded, and a missed invoke is logged rather than failing the send.
 */
export async function dispatchSystemEmailSentSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: SystemEmailSentEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'system-email-sent',
		buildIdempotencyKey: (savedPackage) =>
			buildSystemEmailSentIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: systemEmailSentSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
