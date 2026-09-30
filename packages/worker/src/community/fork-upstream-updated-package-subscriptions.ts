import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	loadMatchingPackageSubscriptions,
	mapSettledInChunks,
	type LoadedPackageSubscription,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { readRetryablePackageInvocationInfrastructureCode } from '#worker/package-invocations/infrastructure-codes.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import {
	buildCommunityForkUpstreamUpdatedEvent,
	communityForkUpstreamUpdatedTopic,
} from './fork-upstream-updated-subscription-event.ts'
import { type CommunityForkUpstreamUpdatedDispatchQueueMessage } from './listing-published-dispatch-queue-producer.ts'
import { listCommunityForksByListingId } from './repo.ts'
import { getCommunityListingPublishedForAdmin } from './service.ts'
import { type CommunityForkRecord } from './types.ts'

const communityForkUpstreamUpdatedSubscriptionActorTokenId =
	'internal:community-fork-upstream-updated-subscriptions'

function groupForksByForker(forks: ReadonlyArray<CommunityForkRecord>) {
	const byForker = new Map<string, Array<CommunityForkRecord>>()
	for (const fork of forks) {
		const existing = byForker.get(fork.forkerUserId)
		if (existing) existing.push(fork)
		else byForker.set(fork.forkerUserId, [fork])
	}
	return byForker
}

/**
 * Fans a listing republish out to every forker of that listing: one event per
 * fork, delivered to that forker's own packages that declare the topic.
 * Forks already at the new pinned commit are skipped. A forker whose
 * subscriber discovery fails is skipped for this attempt; discovery and
 * pre-handler infrastructure failures reject after all siblings finish so the
 * Queue retries, and per-invocation idempotency keys make redelivery replay.
 */
export async function dispatchCommunityForkUpstreamUpdatedSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	message: Omit<CommunityForkUpstreamUpdatedDispatchQueueMessage, 'kind'>
}) {
	const { message } = input
	const forks = (
		await listCommunityForksByListingId(input.env.APP_DB, {
			listingId: message.listingId,
		})
	).filter((fork) => fork.originCommit !== message.current.pinnedCommit)
	if (forks.length === 0) return []

	const forksByForker = groupForksByForker(forks)
	const baseUrl = getAppBaseUrl({ env: input.env })
	const listing = await getCommunityListingPublishedForAdmin({
		db: input.env.APP_DB,
		baseUrl,
		listingId: message.listingId,
	})
	if (!listing) {
		throw new CommunityListingPublishedDispatchCancelledError(message.listingId)
	}

	const discovered = await mapSettledInChunks(
		[...forksByForker.keys()],
		async (forkerUserId) => ({
			forkerUserId,
			...(await loadMatchingPackageSubscriptions({
				env: input.env,
				baseUrl,
				userId: forkerUserId,
				topic: communityForkUpstreamUpdatedTopic,
			})),
		}),
	)
	const deliveries: Array<{
		fork: CommunityForkRecord
		subscription: LoadedPackageSubscription
	}> = []
	const discoveryErrors: Array<unknown> = []
	for (const result of discovered) {
		if (result.status === 'rejected') {
			discoveryErrors.push(result.reason)
			continue
		}
		discoveryErrors.push(...result.value.discoveryErrors)
		for (const fork of forksByForker.get(result.value.forkerUserId) ?? []) {
			for (const subscription of result.value.subscriptions) {
				deliveries.push({ fork, subscription })
			}
		}
	}

	const invoked = await runQueueableDynamicWorkerWork(
		async () =>
			await mapSettledInChunks(
				deliveries,
				async ({ fork, subscription: { savedPackage } }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: communityForkUpstreamUpdatedTopic,
						params: buildCommunityForkUpstreamUpdatedEvent({
							eventId: message.eventId,
							listing,
							fork,
							previous: message.previous,
							current: message.current,
							publishedAt: message.publishedAt,
						}) as Record<string, unknown>,
						idempotencyKey: `community-fork-upstream-updated:${message.eventId}:${fork.id}:${savedPackage.id}`,
						source: 'community-fork-upstream-updated',
						actorTokenId: communityForkUpstreamUpdatedSubscriptionActorTokenId,
					})
					const retryableCode =
						readRetryablePackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Retryable package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				},
			),
	)
	const invocationErrors: Array<unknown> = []
	const responses = invoked.map((result, index) => {
		if (result.status === 'fulfilled') return result.value
		console.warn('community-fork-upstream-updated-invocation-failed', {
			listingId: message.listingId,
			forkId: deliveries[index]?.fork.id,
			packageId: deliveries[index]?.subscription.savedPackage.id,
			error: result.reason,
		})
		invocationErrors.push(result.reason)
		return null
	})
	if (discoveryErrors.length > 0) {
		throw new Error(
			'Community fork upstream-updated subscription discovery failed.',
			{ cause: discoveryErrors[0] },
		)
	}
	if (invocationErrors.length > 0) {
		throw new Error(
			'Community fork upstream-updated dispatch encountered retryable package invocation infrastructure errors.',
			{ cause: invocationErrors[0] },
		)
	}
	return responses
}
