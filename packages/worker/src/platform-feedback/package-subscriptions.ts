import { getAppBaseUrl } from '#app/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'
import { getPlatformFeedbackForAdmin } from './service.ts'

const platformFeedbackSubscriptionActorTokenId =
	'internal:platform-feedback-subscriptions'

export async function dispatchPlatformFeedbackSubmittedSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	feedbackId: string
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: platformFeedbackSubmittedTopic,
		getParams: async () => {
			const feedback = await getPlatformFeedbackForAdmin({
				db: input.env.APP_DB,
				feedbackId: input.feedbackId,
			})
			if (!feedback) {
				throw new PlatformFeedbackDispatchCancelledError(input.feedbackId)
			}
			return buildPlatformFeedbackSubmittedEvent({
				baseUrl,
				feedback,
			}) as Record<string, unknown>
		},
		source: 'platform-feedback',
		buildIdempotencyKey: (savedPackage) =>
			`platform-feedback:${input.feedbackId}:${savedPackage.id}:${platformFeedbackSubmittedTopic}`,
		actorTokenId: platformFeedbackSubscriptionActorTokenId,
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
	})
}
