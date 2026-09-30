import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchCommunityListingPublishedSubscriptionEvent: vi.fn(),
	dispatchCommunityForkUpstreamUpdatedSubscriptionEvents: vi.fn(),
}))

vi.mock('./listing-published-package-subscriptions.ts', () => ({
	dispatchCommunityListingPublishedSubscriptionEvent:
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
}))
vi.mock('./fork-upstream-updated-package-subscriptions.ts', () => ({
	dispatchCommunityForkUpstreamUpdatedSubscriptionEvents:
		mocks.dispatchCommunityForkUpstreamUpdatedSubscriptionEvents,
}))

const { handleCommunityListingPublishedDispatchQueue } =
	await import('./listing-published-dispatch-queue.ts')

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-07-20T01:01:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

function createBatch(messages: Array<ReturnType<typeof createQueueMessage>>) {
	return {
		queue: 'kody-community-listing-published-dispatch',
		messages,
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>
}

test('community listing published queue acks valid, invalid, and cancelled messages and retries transient failures', async () => {
	consoleError.mockImplementation(() => {})
	const valid = createQueueMessage('valid', {
		eventId: 'event-1',
		listingId: 'listing-1',
	})
	const invalidExtra = createQueueMessage('invalid-extra', {
		eventId: 'event-2',
		listingId: 'listing-2',
		extra: true,
	})
	const deleted = createQueueMessage('deleted', {
		eventId: 'event-3',
		listingId: 'listing-deleted',
	})
	const transient = createQueueMessage('transient', {
		eventId: 'event-4',
		listingId: 'listing-3',
	})
	mocks.dispatchCommunityListingPublishedSubscriptionEvent
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new CommunityListingPublishedDispatchCancelledError('listing-deleted'),
		)
		.mockRejectedValueOnce(new Error('D1 unavailable'))

	await handleCommunityListingPublishedDispatchQueue(
		createBatch([valid, invalidExtra, deleted, transient]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

	expect(
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
	).toHaveBeenCalledTimes(3)
	expect(
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		eventId: 'event-1',
		listingId: 'listing-1',
	})
	for (const message of [valid, invalidExtra, deleted]) {
		expect(message.ack).toHaveBeenCalledTimes(1)
		expect(message.retry).not.toHaveBeenCalled()
	}
	expect(transient.ack).not.toHaveBeenCalled()
	expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'community-listing-published-dispatch-queue-processing-failed',
		expect.objectContaining({
			queueMessageId: 'transient',
			eventId: 'event-4',
			listingId: 'listing-3',
			error: expect.any(Error),
		}),
	)
})

test('fork upstream-updated messages route to forker fan-out; malformed ones ack without dispatch', async () => {
	consoleError.mockImplementation(() => {})
	const release = {
		previous: { pinnedCommit: 'commit-1', packageVersion: null },
		current: { pinnedCommit: 'commit-2', packageVersion: '2.0.0' },
	}
	const valid = createQueueMessage('fork-valid', {
		kind: 'fork_upstream_updated',
		eventId: 'event-1',
		listingId: 'listing-1',
		...release,
		publishedAt: '2026-09-30T12:00:00.000Z',
	})
	const missingCurrent = createQueueMessage('fork-missing-current', {
		kind: 'fork_upstream_updated',
		eventId: 'event-2',
		listingId: 'listing-1',
		previous: release.previous,
		publishedAt: '2026-09-30T12:00:00.000Z',
	})
	const badVersion = createQueueMessage('fork-bad-version', {
		kind: 'fork_upstream_updated',
		eventId: 'event-3',
		listingId: 'listing-1',
		previous: release.previous,
		current: { pinnedCommit: 'commit-2', packageVersion: 2 },
		publishedAt: '2026-09-30T12:00:00.000Z',
	})
	const cancelled = createQueueMessage('fork-cancelled', {
		kind: 'fork_upstream_updated',
		eventId: 'event-4',
		listingId: 'listing-gone',
		...release,
		publishedAt: '2026-09-30T12:00:00.000Z',
	})
	const transient = createQueueMessage('fork-transient', {
		kind: 'fork_upstream_updated',
		eventId: 'event-5',
		listingId: 'listing-1',
		...release,
		publishedAt: '2026-09-30T12:00:00.000Z',
	})
	mocks.dispatchCommunityForkUpstreamUpdatedSubscriptionEvents
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new CommunityListingPublishedDispatchCancelledError('listing-gone'),
		)
		.mockRejectedValueOnce(new Error('discovery failed'))

	await handleCommunityListingPublishedDispatchQueue(
		createBatch([valid, missingCurrent, badVersion, cancelled, transient]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

	expect(
		mocks.dispatchCommunityListingPublishedSubscriptionEvent,
	).not.toHaveBeenCalled()
	expect(
		mocks.dispatchCommunityForkUpstreamUpdatedSubscriptionEvents,
	).toHaveBeenCalledTimes(3)
	expect(
		mocks.dispatchCommunityForkUpstreamUpdatedSubscriptionEvents,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		message: {
			eventId: 'event-1',
			listingId: 'listing-1',
			...release,
			publishedAt: '2026-09-30T12:00:00.000Z',
		},
	})
	for (const message of [valid, missingCurrent, badVersion, cancelled]) {
		expect(message.ack).toHaveBeenCalledTimes(1)
		expect(message.retry).not.toHaveBeenCalled()
	}
	expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledWith(
		'community-listing-published-dispatch-queue-processing-failed',
		expect.objectContaining({
			queueMessageId: 'fork-transient',
			kind: 'fork_upstream_updated',
			eventId: 'event-5',
		}),
	)
})
