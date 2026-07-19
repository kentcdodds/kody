import { getAppBaseUrl } from '#app/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'
import { resolvePlatformFeedbackSubmitterIdentity } from './submitter-identity.ts'
import { type PlatformFeedbackRecord } from './types.ts'

const platformFeedbackSubscriptionActorTokenId =
	'internal:platform-feedback-subscriptions'

export async function dispatchPlatformFeedbackSubmittedSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	feedback: PlatformFeedbackRecord
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const submitter = await resolvePlatformFeedbackSubmitterIdentity(
		input.env.APP_DB,
		input.feedback.submitterUserId,
	)
	if (submitter.username === null && submitter.email === null) {
		console.warn('platform-feedback-submitter-identity-missing', {
			feedbackId: input.feedback.id,
			submitterUserId: input.feedback.submitterUserId,
		})
	}
	const payload = buildPlatformFeedbackSubmittedEvent({
		baseUrl,
		feedback: input.feedback,
		submitter,
	})
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: platformFeedbackSubmittedTopic,
		getParams: () => payload as Record<string, unknown>,
		source: 'platform-feedback',
		buildIdempotencyKey: (savedPackage) =>
			`platform-feedback:${input.feedback.id}:${savedPackage.id}:${platformFeedbackSubmittedTopic}`,
		actorTokenId: platformFeedbackSubscriptionActorTokenId,
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
	})
}
