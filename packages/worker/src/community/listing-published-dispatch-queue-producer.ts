import { type CommunityListingRelease } from './fork-upstream-updated-subscription-event.ts'

export type CommunityListingPublishedDispatchQueueMessage = {
	eventId: string
	listingId: string
}

export const communityForkUpstreamUpdatedDispatchKind = 'fork_upstream_updated'

/**
 * Republish fan-out to forkers shares the listing-published queue. Previous
 * and current releases travel in the message because the listing row only
 * holds the latest values by the time the consumer runs.
 */
export type CommunityForkUpstreamUpdatedDispatchQueueMessage = {
	kind: typeof communityForkUpstreamUpdatedDispatchKind
	eventId: string
	listingId: string
	previous: CommunityListingRelease
	current: CommunityListingRelease
	publishedAt: string
}

type CommunityListingDispatchQueueMessage =
	| CommunityListingPublishedDispatchQueueMessage
	| CommunityForkUpstreamUpdatedDispatchQueueMessage

export async function enqueueCommunityListingPublishedDispatch(input: {
	queue: Pick<Queue<CommunityListingDispatchQueueMessage>, 'send'>
	listingId: string
}) {
	await input.queue.send({
		eventId: crypto.randomUUID(),
		listingId: input.listingId,
	})
}

export async function enqueueCommunityForkUpstreamUpdatedDispatch(input: {
	queue: Pick<Queue<CommunityListingDispatchQueueMessage>, 'send'>
	listingId: string
	previous: CommunityListingRelease
	current: CommunityListingRelease
	publishedAt: string
}) {
	await input.queue.send({
		kind: communityForkUpstreamUpdatedDispatchKind,
		eventId: crypto.randomUUID(),
		listingId: input.listingId,
		previous: input.previous,
		current: input.current,
		publishedAt: input.publishedAt,
	})
}
