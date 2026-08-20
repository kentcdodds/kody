import { expect, test } from 'vitest'
import {
	buildCommunityListingPublishedEvent,
	communityListingPublishedTopic,
} from './listing-published-subscription-event.ts'

test('buildCommunityListingPublishedEvent keeps metadata-only canonical public_url', () => {
	const event = buildCommunityListingPublishedEvent({
		eventId: 'event-1',
		listing: {
			id: 'listing-1',
			name: '@owner/discord-gateway',
			kodyId: 'discord-gateway',
			description: 'Discord helpers',
			publisherUsername: 'owner',
			publishedAt: '2026-07-20T01:00:00.000Z',
			publicUrl: 'https://heykody.dev/@owner/discord-gateway',
		},
	})

	expect(event).toEqual({
		event: communityListingPublishedTopic,
		event_id: 'event-1',
		listing: {
			id: 'listing-1',
			name: '@owner/discord-gateway',
			kody_id: 'discord-gateway',
			description: 'Discord helpers',
			public_url: 'https://heykody.dev/@owner/discord-gateway',
		},
		publisher: { username: 'owner' },
		published_at: '2026-07-20T01:00:00.000Z',
	})
	expect(JSON.stringify(event)).not.toContain('user_id')
	expect(JSON.stringify(event)).not.toContain('email')
	expect(event.listing.public_url).not.toContain('/community/')
	expect(event.listing.public_url).toContain('/@owner/discord-gateway')
})
