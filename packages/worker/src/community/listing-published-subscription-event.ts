export const communityListingPublishedTopic = 'community.listing.published'

export type CommunityListingPublishedEvent = {
	event: typeof communityListingPublishedTopic
	event_id: string
	listing: {
		id: string
		name: string
		kody_id: string
		description: string | null
		public_url: string
	}
	publisher: {
		username: string | null
	}
	published_at: string
}

export type CommunityListingPublishedProjection = {
	id: string
	name: string
	kodyId: string
	description: string | null
	publisherUsername: string | null
	publishedAt: string
	publicUrl: string
}

export function buildCommunityListingPublishedEvent(input: {
	eventId: string
	listing: CommunityListingPublishedProjection
}): CommunityListingPublishedEvent {
	return {
		event: communityListingPublishedTopic,
		event_id: input.eventId,
		listing: {
			id: input.listing.id,
			name: input.listing.name,
			kody_id: input.listing.kodyId,
			description: input.listing.description,
			public_url: input.listing.publicUrl,
		},
		publisher: {
			username: input.listing.publisherUsername,
		},
		published_at: input.listing.publishedAt,
	}
}
