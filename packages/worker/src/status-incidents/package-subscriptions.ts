import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildStatusIncidentIdempotencyKey,
	type StatusIncidentEvent,
} from './subscription-event.ts'

const statusIncidentSubscriptionActorTokenId =
	'internal:status-incident-subscriptions'

/**
 * Fans a status-page incident to admin-owned packages that declare
 * `status.incident.opened` or `status.incident.resolved`. Best-effort: the
 * status worker already persisted the incident, and sweep polling remains the
 * backstop if this invoke path is slow or down.
 */
export async function dispatchStatusIncidentSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	event: StatusIncidentEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: input.event.event,
		getParams: () => input.event as Record<string, unknown>,
		source: 'status-incidents',
		buildIdempotencyKey: (savedPackage) =>
			buildStatusIncidentIdempotencyKey({
				event: input.event,
				packageId: savedPackage.id,
			}),
		actorTokenId: statusIncidentSubscriptionActorTokenId,
		waitUntil: input.waitUntil,
	})
}
