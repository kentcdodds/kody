import { expect, test, vi } from 'vitest'
import { CommunityActivityDispatchCancelledError } from './errors.ts'
import {
	buildCommunityActivityRecordedEvent,
	communityActivityRecordedTopic,
} from './activity-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
	getCommunityActivityForAdmin: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

vi.mock('./service.ts', () => ({
	getCommunityActivityForAdmin: mocks.getCommunityActivityForAdmin,
}))

const { dispatchCommunityActivityRecordedSubscriptionEvent } =
	await import('./activity-package-subscriptions.ts')

const ratingActivity = {
	id: 'rating-1',
	kind: 'rating' as const,
	listingId: 'listing-1',
	listingName: '@owner/package',
	listingKodyId: 'package',
	actingUsername: 'rater',
	occurredAt: '2026-07-20T01:00:00.000Z',
	stars: 5,
	adaptationEffort: 2,
}

test('community activity dispatch builds metadata-only events through admin package fan-out', async () => {
	mocks.getCommunityActivityForAdmin.mockResolvedValue(ratingActivity)
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

	const result = await dispatchCommunityActivityRecordedSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		},
		eventId: 'event-1',
		kind: 'rating',
		activityId: 'rating-1',
	})

	expect(mocks.getCommunityActivityForAdmin).toHaveBeenCalledWith({
		db: expect.anything(),
		kind: 'rating',
		activityId: 'rating-1',
	})
	expect(result[0]).toMatchObject({
		params: buildCommunityActivityRecordedEvent({
			eventId: 'event-1',
			activity: ratingActivity,
		}),
		idempotencyKey:
			'community-activity:event-1:package-1:community.activity.recorded',
		input: {
			topic: communityActivityRecordedTopic,
			source: 'community-activity',
			actorTokenId: 'internal:community-activity-subscriptions',
			retryDiscoveryFailures: true,
			retryInvocationInfrastructureFailures: true,
		},
	})
	const payload = result[0]?.params as Record<string, unknown>
	expect(payload).toEqual({
		event: 'community.activity.recorded',
		event_id: 'event-1',
		activity: {
			id: 'rating-1',
			kind: 'rating',
			listing: {
				id: 'listing-1',
				name: '@owner/package',
				kody_id: 'package',
			},
			actor: { username: 'rater' },
			occurred_at: '2026-07-20T01:00:00.000Z',
			stars: 5,
			adaptation_effort: 2,
		},
	})
	expect(JSON.stringify(payload)).not.toContain('note')
	expect(JSON.stringify(payload)).not.toContain('user_id')

	mocks.getCommunityActivityForAdmin.mockResolvedValue(null)
	await expect(
		dispatchCommunityActivityRecordedSubscriptionEvent({
			env: {
				APP_DB: {} as D1Database,
				BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
				APP_BASE_URL: 'https://heykody.dev',
			},
			eventId: 'event-deleted',
			kind: 'fork',
			activityId: 'fork-deleted',
		}),
	).rejects.toBeInstanceOf(CommunityActivityDispatchCancelledError)
})
