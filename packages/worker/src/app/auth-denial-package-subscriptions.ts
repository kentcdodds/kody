import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildAuthDenialBurstIdempotencyKey,
	type AuthDenialBurstEvent,
} from './auth-denial-subscription-event.ts'

const authDenialBurstSubscriptionActorTokenId =
	'internal:auth-denial-burst-subscriptions'

/**
 * Fans an MCP auth-denial burst snapshot to admin-owned packages that
 * declare `auth.denial.burst`. Best-effort: audit rows already exist, and
 * a missed invoke is logged rather than failing the hourly cron.
 */
export async function dispatchAuthDenialBurstSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: AuthDenialBurstEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'auth-denial-burst',
		buildIdempotencyKey: (savedPackage) =>
			buildAuthDenialBurstIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: authDenialBurstSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
