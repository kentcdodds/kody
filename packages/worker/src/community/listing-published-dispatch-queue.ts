import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import { type CommunityListingPublishedDispatchQueueMessage } from './listing-published-dispatch-queue-producer.ts'
import { dispatchCommunityListingPublishedSubscriptionEvent } from './listing-published-package-subscriptions.ts'

const communityListingPublishedDispatchRetryDelaySeconds = 30

function parseCommunityListingPublishedDispatchQueueMessage(
	body: unknown,
): CommunityListingPublishedDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const eventId = record['eventId']
	const listingId = record['listingId']
	if (
		Object.keys(record).length !== 2 ||
		typeof eventId !== 'string' ||
		!eventId.trim() ||
		typeof listingId !== 'string' ||
		!listingId.trim()
	) {
		return null
	}
	return {
		eventId: eventId.trim(),
		listingId: listingId.trim(),
	}
}

export async function handleCommunityListingPublishedDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
) {
	for (const queueMessage of batch.messages) {
		const parsed = parseCommunityListingPublishedDispatchQueueMessage(
			queueMessage.body,
		)
		if (!parsed) {
			queueMessage.ack()
			continue
		}
		try {
			await dispatchCommunityListingPublishedSubscriptionEvent({
				env,
				...parsed,
			})
			queueMessage.ack()
		} catch (error) {
			if (error instanceof CommunityListingPublishedDispatchCancelledError) {
				queueMessage.ack()
				continue
			}
			console.error(
				'community-listing-published-dispatch-queue-processing-failed',
				{
					queueMessageId: queueMessage.id,
					...parsed,
					error,
				},
			)
			queueMessage.retry({
				delaySeconds: communityListingPublishedDispatchRetryDelaySeconds,
			})
		}
	}
}
