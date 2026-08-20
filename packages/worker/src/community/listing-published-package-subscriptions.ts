import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import {
	buildCommunityListingPublishedEvent,
	communityListingPublishedTopic,
} from './listing-published-subscription-event.ts'
import { getCommunityListingPublishedForAdmin } from './service.ts'

const communityListingPublishedSubscriptionActorTokenId =
	'internal:community-listing-published-subscriptions'

export async function dispatchCommunityListingPublishedSubscriptionEvent(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	eventId: string
	listingId: string
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl,
		topic: communityListingPublishedTopic,
		getParams: async () => {
			const listing = await getCommunityListingPublishedForAdmin({
				db: input.env.APP_DB,
				baseUrl,
				listingId: input.listingId,
			})
			if (!listing) {
				throw new CommunityListingPublishedDispatchCancelledError(
					input.listingId,
				)
			}
			return buildCommunityListingPublishedEvent({
				eventId: input.eventId,
				listing,
			}) as Record<string, unknown>
		},
		source: 'community-listing-published',
		buildIdempotencyKey: (savedPackage) =>
			`community-listing-published:${input.eventId}:${savedPackage.id}:${communityListingPublishedTopic}`,
		actorTokenId: communityListingPublishedSubscriptionActorTokenId,
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
	})
}
