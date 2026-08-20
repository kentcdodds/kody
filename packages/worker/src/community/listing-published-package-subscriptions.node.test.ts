import { expect, test, vi } from 'vitest'
import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import {
	buildCommunityListingPublishedEvent,
	communityListingPublishedTopic,
} from './listing-published-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
	getCommunityListingPublishedForAdmin: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

vi.mock('./service.ts', () => ({
	getCommunityListingPublishedForAdmin:
		mocks.getCommunityListingPublishedForAdmin,
}))

const { dispatchCommunityListingPublishedSubscriptionEvent } =
	await import('./listing-published-package-subscriptions.ts')

const publishedListing = {
	id: 'listing-1',
	name: '@owner/discord-gateway',
	kodyId: 'discord-gateway',
	description: 'Discord helpers',
	publisherUsername: 'owner',
	publishedAt: '2026-07-20T01:00:00.000Z',
	publicUrl: 'https://heykody.dev/@owner/discord-gateway',
}

test('community listing published dispatch builds metadata-only events through admin package fan-out', async () => {
	mocks.getCommunityListingPublishedForAdmin.mockResolvedValue(publishedListing)
	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: {
			getParams: () => Promise<Record<string, unknown>>
			buildIdempotencyKey: (savedPackage: { id: string }) => string
			[key: string]: unknown
		}) => [
			{
				params: await input.getParams(),
				idempotencyKey: input.buildIdempotencyKey({ id: 'package-1' }),
				input,
			},
		],
	)

	const result = await dispatchCommunityListingPublishedSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		},
		eventId: 'event-1',
		listingId: 'listing-1',
	})

	expect(mocks.getCommunityListingPublishedForAdmin).toHaveBeenCalledWith({
		db: expect.anything(),
		baseUrl: 'https://heykody.dev',
		listingId: 'listing-1',
	})
	expect(result[0]).toMatchObject({
		params: buildCommunityListingPublishedEvent({
			eventId: 'event-1',
			listing: publishedListing,
		}),
		idempotencyKey:
			'community-listing-published:event-1:package-1:community.listing.published',
		input: {
			topic: communityListingPublishedTopic,
			source: 'community-listing-published',
			actorTokenId: 'internal:community-listing-published-subscriptions',
			retryDiscoveryFailures: true,
			retryInvocationInfrastructureFailures: true,
		},
	})
	const payload = result[0]?.params as Record<string, unknown>
	expect(payload).toEqual({
		event: 'community.listing.published',
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
	expect(JSON.stringify(payload)).not.toContain('user_id')
	expect(JSON.stringify(payload)).not.toContain('email')
	expect(JSON.stringify(payload)).not.toContain('/community/')
	expect((payload.listing as { public_url: string }).public_url).toContain(
		'/@owner/discord-gateway',
	)

	mocks.getCommunityListingPublishedForAdmin.mockResolvedValue(null)
	await expect(
		dispatchCommunityListingPublishedSubscriptionEvent({
			env: {
				APP_DB: {} as D1Database,
				BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
				APP_BASE_URL: 'https://heykody.dev',
			},
			eventId: 'event-deleted',
			listingId: 'listing-deleted',
		}),
	).rejects.toBeInstanceOf(CommunityListingPublishedDispatchCancelledError)
})
